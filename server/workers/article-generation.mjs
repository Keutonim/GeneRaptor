// M1: BullMQ Worker replaced by the in-process queue
// shim — same handler, same UnrecoverableError semantics, no Redis. The shim
// runs with concurrency 1; the worker's own attempt loop is the retry story.
import { UnrecoverableError } from '../lib/queue-shim.mjs';
import { prisma } from '../db.mjs';
import { articleGenerationQueue } from '../queue.mjs';
import { broadcastProgress } from '../websocket.mjs';
import {
  buildRoleExecutionPayload,
  parseRoleExecutionResult,
  callRouterAI,
  callRouterAIWithFallbackChain,
  buildSemanticCoreContext,
  resolveEnvNumber,
} from '../agent-role-execution.mjs';
import { agentRoleData } from '../agent-role-data.mjs';
// Settings audit (2026-10-26): правки systemPrompt агентских ролей.
// Воркер может жить отдельным процессом — кэш правок подтягиваем в нём же.
import { loadAgentRoleOverrides } from '../lib/agent-role-overrides.mjs';
import {
  generateFallbackArticle,
  mergeEmptySections,
  trimOverlongArticleBody,
  ensureH1WithMainQuery,
  injectExpertsBlock,
  ensureSiteMentions,
  reduceKeySpam,
  // P2-2: deterministic form/button recommendation block —
  // B→I handoff, called at the frozen slot of the saveFinalVersion chain
  // (after ensureSiteMentions, before the 2nd merge pass).
  injectFormRecommendationBlock,
  CHUNK_TAIL_RESERVE_CHARS,
} from '../article-post-processor.mjs';
// Единый слой внешнего веб-поиска (server/lib/web-search/):
// keyless-backend по умолчанию, Serper и Yandex — опциональные платные.
// Контракт: search(query, { limit, lang }) → [{ title, url, snippet }].
// Любой сбой деградирует в пустой результат с кодом причины — генерация не падает.
import { searchWeb } from '../lib/web-search/index.mjs';
import { normalizeResearchSource, serializeResearchMetadata, RESEARCH_PROVIDERS } from '../lib/research-source.mjs';
import { canonicalSignature } from '../lib/url-normalize.mjs';
import { stripCitations } from '../lib/strip-citations.mjs';
import { injectInternalLinks } from '../lib/internal-linker.mjs';
// P1d (2026-09-18): UTM-разметка internal-ссылок (флаг
// GENERAPTOR_UTM_ENABLED, дефолт ВЫКЛ) + RAW/UTM-формы для постчек-контекста.
import { isUtmEnabled } from '../lib/utm-builder.mjs';
import { buildConsensus } from '../lib/consensus-builder.mjs';
import {
  renderMarkdownToHtml,
  htmlToPlainText,
} from '../lib/markdown-renderer.mjs';
import { sanitizeArticle, stripTrailingContinuation } from '../lib/article-sanitizer.mjs';
// Cover checkbox wave: the post-finalize cover
// phase lives in cover-service (not here) — the worker only fires it.
import { maybeGenerateCover } from '../lib/cover-service.mjs';
import { normalizeHeadings } from '../lib/heading-normalizer.mjs';
import { generateUnusualFaqMarkdown, hasUnusualFaqSection } from '../lib/faq-generator.mjs';
// P1b+P1c (2026-09-18): deterministic presentation
// meta — «Обновлено: DD.MM.YYYY» line (signature house pattern) and the
// JSON-LD (Article + FAQPage) script attached to contentHtml after the
// postcheck input assembly.
import {
  appendUpdatedDateLine,
  extractFaqEntries,
  buildArticleJsonLd,
  attachArticleJsonLd,
} from '../lib/article-view-meta.mjs';
// seo-round: единый источник SEO-порогов (лимит ссылок линкера — верх окна
// linksByLength по плановому объёму, FIX-S2; mentionsByLength — min
// упоминаний компании для seo-deterministic ensureSiteMentions).
import { linksByLength, mentionsByLength } from '../lib/seo-standards.mjs';
import {
  runArticlePostcheck,
  resolvePostcheckMode,
  POSTCHECK_AGENT_NAME,
} from '../lib/article-postcheck.mjs';
// Option A (2026-09-17, 20260917-openresearch-integration): deterministic
// report-only grounding score (autoresearch P1 ground-truth metric).
import {
  computeGroundingScore,
  sourcesFromResearchRows,
} from '../lib/grounding-score.mjs';

/**
 * normalizedUrl for a research-source row. Empty signature → null (so the
 * @@unique([articleId, normalizedUrl, provider]) constraint treats no-URL
 * sources as non-conflicting: NULLs never collide under a Postgres unique).
 * @param {string} sourceUrl
 * @returns {string|null}
 */
function normalizedUrlOrNull(sourceUrl) {
  const sig = canonicalSignature(sourceUrl);
  return sig || null;
}

/**
 * Splits round candidates into genuinely NEW sources and already-seen ones.
 *
 * Pure function (exported for tests, same pattern as researchProviderFor):
 * the signature of a candidate is `normalizedUrl || canonicalSignature(sourceUrl)`
 * — the very key the persistence layer deduplicates by. A candidate without a
 * valid signature is never "new"; an already-seen signature is dropped; the
 * input array and the seen set are NOT mutated (the returned set is a copy
 * extended with the fresh signatures).
 *
 * @param {Array<{normalizedUrl?: string, sourceUrl?: string}>} candidates
 * @param {Set<string>|Iterable<string>} [seenSignatures]
 * @returns {{fresh: Array<object>, signatures: Set<string>}}
 */
export function splitNewSources(candidates, seenSignatures) {
  const signatures = new Set(seenSignatures || []);
  const fresh = [];
  for (const item of candidates || []) {
    const sig = item?.normalizedUrl || canonicalSignature(item?.sourceUrl);
    if (!sig || signatures.has(sig)) continue;
    signatures.add(sig);
    fresh.push(item);
  }
  return { fresh, signatures };
}

/**
 * Persist a batch of research-source rows for one article on SQLite.
 *
 * Idempotency without engine-level duplicate skipping (the SQLite provider
 * does not support that createMany option):
 *   1. collapse the batch by (normalizedUrl, provider) — the @@unique key;
 *      rows with a NULL normalizedUrl never collide and are kept as-is;
 *   2. drop rows whose key is already stored for this article (a known
 *      existing key would make createMany raise P2002);
 *   3. createMany the remainder; on an unforeseen unique conflict (a
 *      concurrent writer between the check and the insert) fall back to
 *      per-row inserts, ignoring rows that already exist.
 * Any other error propagates to the caller — the research call sites wrap
 * this in their non-blocking catch, so generation never dies on evidence.
 *
 * @param {string} articleId
 * @param {Array<object>} rows — persistence-ready researchSource rows
 * @returns {Promise<number>} number of rows inserted
 */
export async function persistResearchSources(articleId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const keyOf = (r) => `${r.provider}\u0000${r.normalizedUrl}`;

  // 1. Batch dedup by the unique key. NULL normalizedUrl rows are kept:
  //    NULLs are distinct under the unique constraint and never collide.
  const seen = new Set();
  const batch = [];
  for (const row of rows) {
    if (row.normalizedUrl == null) {
      batch.push(row);
      continue;
    }
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    batch.push(row);
  }

  // 2. Exclude keys already stored for this article.
  const urls = [...new Set(batch.filter((r) => r.normalizedUrl != null).map((r) => r.normalizedUrl))];
  const storedKeys = new Set();
  if (urls.length) {
    const stored = await prisma.researchSource.findMany({
      where: { articleId, normalizedUrl: { in: urls } },
      select: { normalizedUrl: true, provider: true },
    });
    for (const r of stored) storedKeys.add(`${r.provider}\u0000${r.normalizedUrl}`);
  }
  const fresh = batch.filter((r) => r.normalizedUrl == null || !storedKeys.has(keyOf(r)));
  if (fresh.length === 0) return 0;

  // 3. Insert; on an unforeseen unique conflict fall back to per-row
  //    inserts, ignoring rows that already exist (race-safe idempotency).
  try {
    const res = await prisma.researchSource.createMany({ data: fresh });
    return res.count;
  } catch (e) {
    if (e?.code !== 'P2002') throw e;
    let inserted = 0;
    for (const row of fresh) {
      try {
        await prisma.researchSource.create({ data: row });
        inserted += 1;
      } catch (rowError) {
        if (rowError?.code !== 'P2002') throw rowError;
      }
    }
    return inserted;
  }
}

/**
 * M2: источник (crawl) убран — идентичность компании даёт
 * необязательная одиночная строка CompanyProfile (профиль автора):
 * name → упоминания/линкер/JSON-LD/постчек, activeText → контекст ролей.
 * Сбой загрузки НИКОГДА не роняет генерацию (null → обезличенный режим).
 */
async function loadCompanyProfile() {
  try {
    return await prisma.companyProfile.findFirst();
  } catch (e) {
    console.warn(`[Worker] Company profile load failed (non-blocking): ${e?.message || e}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Конфигурация стоимости (можно переопределить через env)           */
/* ------------------------------------------------------------------ */

const COST_INPUT_PER_1K = Number(process.env.ROUTERAI_COST_INPUT_PER_1K || 0.002);
const COST_OUTPUT_PER_1K = Number(process.env.ROUTERAI_COST_OUTPUT_PER_1K || 0.006);
const COST_HARD_MULTIPLIER = Number(process.env.ROUTERAI_COST_HARD_MULTIPLIER || 2.5);

const CRITICAL_MODEL = process.env.ROUTERAI_MODEL_CRITICAL || 'qwen/qwen3.7-plus';
const GENERATION_MODEL = process.env.ROUTERAI_MODEL_GENERATION || 'qwen/qwen3.6-flash';
const STANDARD_MODEL = process.env.ROUTERAI_MODEL_STANDARD || 'deepseek/deepseek-v4-flash';

const TOTAL_STAGES = agentRoleData.length;

// Quality-gate retry-loop: после quality-controller проверяем вердикт.
// Если finalizationAllowed === false ИЛИ factchecker.reviewRequired === true —
// перегенерация с article-author. FIX 2026-07-12: было 2 (3 попытки) — для
// сложных статей с малым количеством источников мало, quality находил новые
// проблемы каждый раз и не сходился.
// W4.2 (2026-08-17): default 5 → 3 (всего 4 прохода автора). Прод-данные
// (аналитик П3): лишние ревизии автора тратили 60–120k токенов и 20–30 мин
// wall-clock без сходимости. W1.1-гейт (MAX_FACTCHECK_REVIEW_PASSES = 2
// прохода фактчек-ревью) ортогонален и НЕ трогается.
// NaN-guard (FIX-F2, паттерн W1.5): Number('мусор') = NaN → сравнения с NaN
// всегда false → бесконечный цикл перегенераций; ПУСТАЯ строка env
// (MAX_QUALITY_RETRIES=) давала Number('')=0 → ноль ретраев. resolveEnvNumber
// возвращает дефолт при null/undefined/''/NaN — единый хелпер для всех
// числовых env настроек.
const MAX_QUALITY_RETRIES_RAW = resolveEnvNumber(process.env.MAX_QUALITY_RETRIES, 3);
const MAX_QUALITY_RETRIES = Number.isFinite(MAX_QUALITY_RETRIES_RAW)
  ? Math.max(0, Math.floor(MAX_QUALITY_RETRIES_RAW))
  : 3;
// Роли, чьи выходы инвалидируются при перегенерации (перезапуск с article-author).
const QUALITY_RESET_ROLES = [
  'article-author',
  'factchecker',
  'seo-reviewer',
  'quality-controller',
  'humanizer',
];

// W1.1 (2026-08-17, аналитик П3/причина №1+№4): factchecker.reviewRequired
// больше не блокирует финализацию бесконечно. Промпт фактчекера требует
// reviewRequired=true почти для любой мед-статьи («остались утверждения,
// требующие специалиста»), а блок-условие QC-gate приравнивало это к вердикту
// «качество не прошло» → вечный цикл перегенераций (в проде: 4 прогона автора,
// +30 мин, ~90k токенов на статью). Теперь: если quality-controller разрешает
// финализацию (finalizationAllowed=true), reviewRequired даёт автору не более
// MAX_FACTCHECK_REVIEW_PASSES ревизионных проходов, после которых статья
// финализируется штатно (решение логируется). finalizationAllowed=false
// работает как раньше — до исчерпания MAX_QUALITY_RETRIES.
const MAX_FACTCHECK_REVIEW_PASSES = 2;

// W4.2 (2026-08-17) → W-retry (2026-08-21): wall-clock бюджет ОДНОГО прогона
// генерации (KPI мастера-плана: среднее время статьи ≤25 мин). Проверяется
// МЕЖДУ ролями и итерациями QC — внутри LLM-вызова действует собственный
// скользящий бюджет W1.5. W-retry: дефолт поднят 25 мин → 120 мин, а при
// исчерпании прогон ПОВТОРЯЕТСЯ с нуля (ретрай-цикл в processArticleGeneration,
// env GENERATION_MAX_ATTEMPTS); только после последней попытки — честный
// needs_review с причиной «Превышен бюджет времени генерации» (контент
// частично готов), а при отсутствии контента — failed (семантика исчерпания
// та же, что в QC-gate). 0/'off' → проверка отключена (возвращает 0).
// Env читается на каждый вызов (тесты/hot-reload), NaN/пустая строка → дефолт
// (FIX-F2: Number('')=0 не должен превращаться в 1с-бюджет), активный бюджет
// clamp ≥1с.
const DEFAULT_GENERATION_WALL_CLOCK_MS = 120 * 60 * 1000;
const WALL_CLOCK_EXHAUSTED_REASON = 'Превышен бюджет времени генерации';

/**
 * Chooses the provider of a search result for the evidence layer.
 *
 * The web-search layer returns the provider of every item: the id of the main
 * engine (Serper, Tavily, Wikipedia …) or the id of a narrow vertical
 * (OpenAlex, Europe PMC …). The item value wins — otherwise a vertical
 * source would be stored under the name of the main engine and the
 * attribution of the article would lie.
 *
 * A provider that the evidence layer does not know is never passed to
 * `normalizeResearchSource` (it would throw and drop the whole evidence
 * layer): such a value falls back to the backend of the search and, as the
 * last resort, to the generic "web".
 *
 * @param {{provider?: string}|null} item a result of the search layer
 * @param {string|null} fallback the backend that produced the search
 * @returns {string} a valid research provider
 */
export function researchProviderFor(item, fallback) {
  const candidates = [item?.provider, fallback];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value && RESEARCH_PROVIDERS.includes(value)) return value;
  }
  return 'web';
}

export function getGenerationWallClockMs() {
  const raw = process.env.GENERATION_WALL_CLOCK_MS;
  // 'off' (любой регистр/обрамление пробелами) — явный kill-switch: без него
  // Number('off')=NaN → resolveEnvNumber вернул бы дефолт (бюджет активен).
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return 0;
  const val = resolveEnvNumber(raw, DEFAULT_GENERATION_WALL_CLOCK_MS);
  if (val === 0) return 0; // 0 — легальный override «отключить проверку»
  return Math.max(1_000, val);
}

// W-retry (2026-08-21): сколько ВСЕГО прогонов генерации допускается внутри
// одного job при исчерпании wall-clock бюджета (НЕ номер попытки очереди —
// ретрай живёт внутри одного job, без манипуляций очередью). Default 2 =
// один полный повтор; 1 = без повторов (поведение до W-retry); 0/негатив → 1;
// NaN/пусто → дефолт (resolveEnvNumber, FIX-F2). Матрица запиннена тестами
// (tests/worker/wall-clock-idempotency.test.mjs).
const DEFAULT_GENERATION_MAX_ATTEMPTS = 2;
export function getGenerationMaxAttempts() {
  const val = resolveEnvNumber(process.env.GENERATION_MAX_ATTEMPTS, DEFAULT_GENERATION_MAX_ATTEMPTS);
  if (!Number.isFinite(val)) return DEFAULT_GENERATION_MAX_ATTEMPTS;
  // Кап 5: каждая попытка получает полный wall-clock бюджет — без капа
  // завышенный env создаёт неограниченный по времени job (footgun QA-ревью).
  return Math.min(5, Math.max(1, Math.floor(val)));
}

/**
 * U3 (2026-08-20): причина needs_review для колонки article.needsReviewReason.
 * Нормализует пробелы и обрезает до maxLen симв. (с многоточием) — колонка
 * читается в списке очереди, короткая строка без переносов.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function buildNeedsReviewReason(text, maxLen = 200) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

/** U3/W-retry: wall-clock причина с фактическим бюджетом и числом попыток. */
function wallClockReason(maxAttempts = getGenerationMaxAttempts()) {
  const minutes = Math.round(getGenerationWallClockMs() / 60_000);
  return buildNeedsReviewReason(
    `${WALL_CLOCK_EXHAUSTED_REASON} (${minutes} мин) — попытки генерации исчерпаны (${maxAttempts}), контент сохранён, требуется проверка`
  );
}

/**
 * W4.5 (2026-08-17): однострочный пер-ролевой дайджест генерации в stdout.
 * Прод-логи теряются при рестартах контейнера (риск R10) — дайджест даёт
 * картину «роль:время:статус:деградации» одной строкой на статью в docker
 * logs. Формат:
 *   [gen-digest] articleId=… totalMs=… roles="role:ms:status:retries:fallbackModel,…"
 * где retries — сколько деградаций цепочки моделей понадобилось (W4.1),
 * fallbackModel — реально исполнившая модель (или «-», если первичная).
 * Никогда не бросает: наблюдаемость не должна ронять финализацию.
 */
function logGenerationDigest(articleId, genTelemetry) {
  try {
    const entries = Array.isArray(genTelemetry?.entries) ? genTelemetry.entries : [];
    const totalMs = Date.now() - (genTelemetry?.startedAtMs ?? Date.now());
    const roles = entries
      .map((e) => `${e.roleId}:${Math.max(0, Number(e.ms) || 0)}:${e.status}:${Number(e.retries) || 0}:${e.fallbackModel || '-'}`)
      .join(',');
    console.log(`[gen-digest] articleId=${articleId} totalMs=${totalMs} roles="${roles}"`);
  } catch {
    // ignore — телеметрия не влияет на пайплайн
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function calculateCostRub(inputTokens, outputTokens, model) {
  const isHard =
    model?.includes('v4') || model?.includes('pro') || model?.includes('hard');
  const multiplier = isHard ? COST_HARD_MULTIPLIER : 1;
  const input = Number(inputTokens) || 0;
  const output = Number(outputTokens) || 0;
  const cost =
    (input / 1000) * COST_INPUT_PER_1K * multiplier +
    (output / 1000) * COST_OUTPUT_PER_1K * multiplier;
  return Number(cost.toFixed(4));
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Карта ролей → статус статьи для отображения прогресса
 */
const ROLE_STATUS_MAP = {
  'topic-selector': 'topic_generation',
  'brief-preparer': 'brief_preparation',
  'knowledge-base-curator': 'knowledge_base',
  'research-analyst': 'research',
  'semantic-strategist': 'semantic_strategy',
  'structure-architect': 'structure',
  'article-author': 'article_writing',
  factchecker: 'factcheck',
  'seo-reviewer': 'seo_review',
  'quality-controller': 'quality_control',
  humanizer: 'humanize',
};

function getRoleStage(roleId) {
  const index = agentRoleData.findIndex((r) => r.id === roleId);
  return index >= 0 ? index + 1 : 0;
}

/*
 * Контракт статуса WS-кадра прогресса (H-06, hardening).
 *
 * Поле `status` описывает СОСТОЯНИЕ ПРОГОНА, а не отдельной роли:
 *   - 'running'  — прогон ещё идёт (кадры старта/завершения РОЛИ);
 *   - 'completed' — прогон ЗАВЕРШЁН (финальный кадр): percent=100,
 *     currentStage=totalStages;
 *   - 'error'    — прогон упал (percent = достигнутая доля);
 *   - 'stopped'  — остановлен оператором.
 *
 * Раньше завершение РОЛИ тоже слалось со статусом 'completed'. Клиент
 * (src/features/generation/GenerationView.tsx) считает 'completed'
 * терминальным и переключает экран на готовую статью — из-за этого UI
 * уезжал на результат уже после первой роли, не дожидаясь конвейера.
 * Завершение роли теперь помечается 'running' (шаг/процент/имя роли в кадре
 * остаются прежними), а 'completed' остаётся только за финальным кадром.
 */

function buildProgressPayload({
  articleId,
  currentStage,
  stageName,
  agentName,
  description,
  percent,
  status,
  message,
}) {
  return {
    type: 'article-progress',
    articleId,
    currentStage,
    totalStages: TOTAL_STAGES,
    stageName: stageName || 'Подготовка',
    agentName: agentName || 'system',
    description: description || stageName || 'Подготовка',
    percent: Math.min(100, Math.max(0, percent)),
    status,
    message,
  };
}

function sendProgress(payload) {
  broadcastProgress(payload.articleId, payload);
}

/**
 * Проверяет, не остановлена ли генерация оператором.
 * Если остановлена — отправляет WebSocket-сообщение и возвращает true.
 */
async function checkStopped(articleId) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { status: true },
  });

  if (article?.status === 'stopped') {
    sendProgress(
      buildProgressPayload({
        articleId,
        currentStage: 0,
        stageName: 'Остановлено',
        agentName: 'system',
        description: 'Генерация остановлена оператором',
        percent: 0,
        status: 'stopped',
        message: 'Генерация остановлена оператором',
      })
    );
    return true;
  }
  return false;
}

/**
 * Извлекает финальные поля статьи из накопленных структурированных выходов ролей
 */
function extractFinalArticle(structuredOutputs) {
  const seo = structuredOutputs['seo-reviewer'] || {};
  const author = structuredOutputs['article-author'] || {};
  const factchecker = structuredOutputs['factchecker'] || {};
  const humanizer = structuredOutputs['humanizer'] || {};
  const structure = structuredOutputs['structure-architect'] || {};

  const title = normalizeText(seo.titleRu || author.titleRu, '');
  const description = normalizeText(seo.descriptionRu || author.descriptionRu, '');
  const h1 = normalizeText(structure.h1Ru || title, '');
  // Приоритет финального контента:
  //   1. humanizer.finalArticleMarkdownRu — стилизация поверх фактчекинг-версии
  //   2. factchecker.checkedArticleMarkdownRu — проверенный черновик
  //   3. author.articleMarkdownRu — исходный авторский черновик
  // Раньше factchecker-вывод вообще не использовался (баг #2).
  // DEFENSIVE STRIP 2026-07-12: финальный контент гарантированно без маркеров
  // {{src:N}} — на случай если humanizer вернул текст с маркерами (модель могла
  // скопировать их из фактчек-версии). Ни один опубликованный артефакт не должен
  // содержать inline-маркеры источников.
  const rawContent = normalizeText(
    humanizer.finalArticleMarkdownRu ||
      factchecker.checkedArticleMarkdownRu ||
      author.articleMarkdownRu,
    ''
  );
  const content = stripCitations(rawContent);

  return { title, description, h1, content };
}

/**
 * Проверяет, является ли ошибка сетевой/502 (или проблема доступа к LLM),
 * из-за которой нужен fallback.
 */
/**
 * Является ли ошибка auth/quota-ошибкой (401/402/403)?
 * Такие ошибки НЕ должны маскироваться fallback'ом — пользователь должен увидеть
 * реальную причину (неверный ключ, исчерпан бюджет), а не «успешный» шаблон.
 */
function isAuthError(status) {
  return status === 401 || status === 402 || status === 403;
}

function authErrorMessage(status) {
  if (status === 401) return 'Ошибка авторизации RouterAI (401). Проверьте ROUTERAI_API_KEY.';
  if (status === 402) return 'Ошибка авторизации RouterAI (402). Проверьте баланс и лимиты.';
  if (status === 403) return 'Доступ запрещён RouterAI (403). Проверьте права ключа.';
  return 'Ошибка авторизации RouterAI.';
}

function isFallbackEligible(error, status) {
  // Auth/quota errors are NEVER fallback-eligible — surface them as failures.
  if (isAuthError(status)) return false;
  if (status === 502) return true;
  if (status >= 500) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|502|network|ECONNREFUSED|ETIMEDOUT|abort|AbortError|не настроен|ENOTFOUND|ECONNRESET/i.test(message);
}

/**
 * Wrap an error as UNRECOVERABLE so the worker's own attempt loop does NOT
 * retry the whole job.
 *
 * Background (Bug #2): the worker retries a job whose handler throws (up to
 * `maxAttempts`, see getGenerationMaxAttempts()). But several failures here
 * are DETERMINISTIC business outcomes, not transient faults:
 *   - quality-control rejected the article `MAX_QUALITY_RETRIES+1` times
 *   - article not found
 *   - auth/quota (401/402/403) — wrong key, not a blip
 *   - a role returned a non-transient HTTP error after fallback paths exhausted
 *   - final content could not be assembled
 * Retrying these from scratch just burns RouterAI tokens (each retry re-runs
 * the full 11-role pipeline, including its own internal QC retry-loop), turning
 * one quality rejection into up to 9 full generations. Marking them
 * unrecoverable makes the job fail immediately so the worker stops.
 *
 * Transient faults (genuine 502 / fetch failed BEFORE fallback is exhausted)
 * are left as normal Errors so the attempt loop still helps.
 */
function unrecoverable(message) {
  return new UnrecoverableError(message);
}

/* ------------------------------------------------------------------ */
/*  Chunked generation для article-author (статьи 20k+ chars)         */
/* ------------------------------------------------------------------ */

// Порог: при targetLength >= CHUNK_THRESHOLD article-author вызывается по
// секциям структуры, а не одним вызовом. Один вызов на 50k chars упирается
// в max_tokens модели + даёт нестабильный обрыв (`finish_reason=length`).
// TEST 2026-07-10: снижен с 20000 до 5000. article-author стабильно падал на fetch failed
// при single-call даже для 10k (payload 17-23k). Factchecker (29k) при этом работает.
// Чанкование по секциям решает: каждый батч компактнее, провайдер не обрывает.
const CHUNK_THRESHOLD = Number(process.env.CHUNK_THRESHOLD ?? 5000);
// Сколько секций структуры отдавать в один вызов модели. 2–3 секции дают
// 5–10k chars на батч — укладываются в SECTION_MAX_TOKENS.
const CHUNK_SECTION_SIZE = Number(process.env.CHUNK_SECTION_SIZE ?? 2);
// max_tokens на один секционный вызов (per-section). Склейка идёт в worker.
// FIX 2026-07-10: было 12000 → deepseek-v4-pro уходил в reasoning-rabbit-hole
// (17366 reasoning tokens, content=0, finish=length). Снижено до 8000: модель
// быстрее переходит от reasoning к content (тест: 1091 reasoning + 575 content = stop).
// Чанков больше, но каждый стабильно возвращает контент.
const SECTION_MAX_TOKENS = Math.round(
  Math.min(12000, Math.max(6000, Number(process.env.SECTION_MAX_TOKENS ?? 8000)))
);
// Обрезка предыдущих секций (summary) чтобы не раздувать payload на поздних батчах.
const PREV_SECTION_SUMMARY_CHARS = 500;

// G2 quality-calibration (2026-08-21): верхний стоп по объёму в чанк-цикле
// автора. Прод-данные 6 статей: BODY-LENGTH-RANGE 5/6 (1.4–4× target) — автор
// честно писал ВСЕ секции плана, а план систематически «тяжелее» таргета.
// Перед запросом ОЧЕРЕДНОГО чанка считаем накопленный объём склейки (символы md):
//   soft: накоплено ≥ soft-порога → этот чанк последний: оставшиеся секции
//         кратко + финальный абзац-вывод, без новых больших блоков;
//   hard: накоплено ≥ hard-порога → секционные чанки больше НЕ запрашиваем:
//         один принудительный завершающий вызов (короткий вывод, без секций).
// Нижний порог (недобор) НЕ трогаем — им управляют QC-gate и lengthDeficit.
//
// FIX-D2 QA (2026-08-21): стоп считался только по collectedMarkdown, а хвост
// статьи (FAQ «10 необычных вопросов» ≈3000 симв. + подпись ≈200) добавляется
// ПОСЛЕ склейки и входит в BODY-LENGTH-RANGE → soft-стоп на 95% таргета давал
// финал >1.4×. Пороги считаются с резервом хвоста:
//   soft = (target − CHUNK_TAIL_RESERVE_CHARS) / target, но не ниже
//          CHUNK_STOP_RATIO_FLOOR (абсолютный пол — короткие статьи не должны
//          останавливаться на первых секциях);
//   hard = soft + 0.20 (прежний опорный зазор 0.95 → 1.15).
// Примеры: target 10000 → soft 0.68 / hard 0.88; 50000 → 0.936 / 1.136.
const CHUNK_VOLUME_SOFT_STOP = 0.95; // опорная точка зазора (см. chunkStopRatios)
const CHUNK_VOLUME_HARD_STOP = 1.15;
// Резерв хвоста (FAQ ~3000 + подпись ~200) — ЕДИНАЯ константа с тримом F2(b)
// (FIX-D3): определена в article-post-processor.mjs и импортируется сюда —
// G2-стопы и детерминированный трим считают от одной и той же базы.
const CHUNK_STOP_RATIO_FLOOR = 0.6;

/** FIX-D2: эффективные soft/hard-пороги стопа с резервом хвоста (FAQ+подпись). */
function chunkStopRatios(targetLen) {
  if (!Number.isFinite(targetLen) || targetLen <= 0) {
    return { soft: CHUNK_VOLUME_SOFT_STOP, hard: CHUNK_VOLUME_HARD_STOP };
  }
  const soft = Math.max(
    CHUNK_STOP_RATIO_FLOOR,
    (targetLen - CHUNK_TAIL_RESERVE_CHARS) / targetLen,
  );
  return { soft, hard: soft + (CHUNK_VOLUME_HARD_STOP - CHUNK_VOLUME_SOFT_STOP) };
}
const CHUNK_SOFT_FINISH_INSTRUCTION =
  'ЗАВЕРШЕНИЕ СТАТЬИ: это ПОСЛЕДНИЙ фрагмент. Оставшиеся секции этого батча раскрой кратко — по одному содержательному абзацу на секцию, ' +
  'затем допиши финальный абзац-вывод по теме статьи. НЕ начинай новых больших блоков и не расширяй уже написанные секции. ' +
  // F2(a) quality-final (2026-08-21): ЯВНЫЙ лимит объёма — «заверши кратко»
  // модель читала как «пиши как раньше» (e2e: финальный чанк 4–5к символов
  // вылетал за 1.4× target). Страховка снизу — детерминированный трим F2(b).
  'Объём финального фрагмента — не более ~1500 символов: оставшиеся секции одним-двумя абзацами каждая + короткий вывод. Не начинай новых тем.';
const CHUNK_FORCED_FINISH_INSTRUCTION =
  'ЗАВЕРШЕНИЕ СТАТЬИ: накопленный объём уже превышает целевой, новые секции НЕ нужны. ' +
  'Верни только короткий финальный абзац-вывод (3–5 предложений), закрывающий статью по существу. ' +
  'НЕ пиши заголовков и не начинай новых блоков.';

/**
 * Разбивает массив секций структуры на батчи по CHUNK_SECTION_SIZE.
 * Возвращает массив массивов секций.
 */
function batchSections(sections) {
  if (!Array.isArray(sections) || !sections.length) return [];
  const batches = [];
  for (let i = 0; i < sections.length; i += CHUNK_SECTION_SIZE) {
    batches.push(sections.slice(i, i + CHUNK_SECTION_SIZE));
  }
  return batches;
}

/**
 * Сводка предыдущей секции (для континуитета тона/стиля).
 * Берёт начало sectionMarkdownRu и обрезает — иначе payload раздуется.
 */
function summarizePrevSection(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  const trimmed = markdown.trim();
  if (trimmed.length <= PREV_SECTION_SUMMARY_CHARS) return trimmed;
  return trimmed.slice(0, PREV_SECTION_SUMMARY_CHARS) + '…';
}

/**
 * Собирает плоский массив ключевых тезисов из вывода structure-architect.
 * Раньше кормил length-aware expansion в postProcessArticle (удалён, P3
 * 2026-08-16); сейчас ключевые тезисы передаются постпроцессору как метаданные
 * для findShortSections (метрика недобора объёма в логах).
 * @param {object} structureData — structuredOutputs['structure-architect']
 * @returns {string[]}
 */
function collectKeyPointsFromStructure(structureData) {
  const sections = Array.isArray(structureData?.sectionsRu) ? structureData.sectionsRu : [];
  const points = [];
  for (const s of sections) {
    if (Array.isArray(s?.keyPointsRu)) points.push(...s.keyPointsRu);
  }
  return points;
}

/**
 * W1.2 (2026-08-17, аналитик П1/причина №3): нормализация текста заголовка для
 * сравнения — нижний регистр, схлопнутые пробелы, снята пунктуация/символы
 * (вкл. «»—–:!). Две темы «Чистка лица: виды процедур» и «чистка лица: виды
 * процедур!» считаются одинаковыми.
 * @param {string} text
 * @returns {string}
 */
function normalizeHeadingText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * W1.2: снимает ВЕДУЩИЕ заголовки-темы (H1/H2) из чанка 2+, если их
 * нормализованный текст совпадает с темой статьи (точное совпадение после
 * нормализации пробелов/регистра/пунктуации). Первый чанк сохраняет H1 темы —
 * он и становится заголовком статьи; повторы из остальных батчей именно так
 * превращались в дубли H2 (normalizer понижает лишние H1, sanitizer дедуплит
 * только смежные).
 * @param {string} chunkMarkdown
 * @param {string[]} topicCandidates — тема статьи (h1Ru структуры, topic статьи)
 * @returns {string}
 */
function stripLeadingTopicHeadings(chunkMarkdown, topicCandidates) {
  if (typeof chunkMarkdown !== 'string' || !chunkMarkdown.trim()) return chunkMarkdown || '';
  const candidates = new Set(
    topicCandidates.map(normalizeHeadingText).filter(Boolean)
  );
  if (!candidates.size) return chunkMarkdown;

  const lines = chunkMarkdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1;
      continue;
    }
    const m = /^ {0,3}#{1,2}[ \t]+(.*?)[ \t]*$/.exec(lines[i]);
    if (!m) break; // первый содержательный токен — не заголовок, дальше не смотрим
    if (!candidates.has(normalizeHeadingText(m[1]))) break; // не тема — не трогаем
    i += 1; // ведущий заголовок-тема: снять
  }
  if (i === 0) return chunkMarkdown;
  return lines.slice(i).join('\n').replace(/^\n+/, '');
}

/**
 * W1.2: страховочный дедуп НЕСМЕЖНЫХ одинаковых H2 по всему документу
 * (keep-first). Санитайзер финальной сборки дедуплит только ПОДРЯД идущие
 * заголовки, а дубли chunk-склейки оказываются в разных местах документа.
 * Снимается только строка заголовка — контент секции сохраняется.
 *
 * Порядок пайплайна: этот дедуп работает на склейке чанков ДО финальных
 * sanitize→normalize (saveFinalVersion), поэтому:
 *   - H2, чей текст совпадает с темой статьи (topicCandidates), удаляется
 *     всегда — тема уже живёт в H1 первого чанка;
 *   - H1 с текстом темы В ЛЮБОЙ позиции, кроме первого заголовка документа,
 *     тоже снимается здесь: иначе heading-normalizer ПОНИЗИТ его до H2 уже
 *     после нашего дедупа и тема задублируется в финальном markdown
 *     (TL-ревью W1: стрип ловит только ВЕДУЩИЕ заголовки чанков).
 * Первый заголовок документа не дропается никогда — normalizer сделает его
 * единственным H1 (в т.ч. `## Тема` на первой строке повысится до `# Тема`).
 * @param {string} markdown
 * @param {string[]} [topicCandidates]
 * @returns {{ markdown: string, removed: number }}
 */
function dedupeNonAdjacentH2(markdown, topicCandidates = []) {
  if (typeof markdown !== 'string' || !markdown) return { markdown, removed: 0 };
  const topics = new Set(
    topicCandidates.map(normalizeHeadingText).filter(Boolean)
  );
  const seen = new Set();
  const lines = markdown.split('\n');
  const drop = new Set();
  let inFence = false;
  let firstHeadingSeen = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Первый заголовок документа неприкосновенен (будущий единственный H1).
    if (!firstHeadingSeen && /^ {0,3}#{1,6}[ \t]/.test(lines[i])) {
      firstHeadingSeen = true;
      const first = /^ {0,3}(#{1,2})[ \t]+(.*?)[ \t]*$/.exec(lines[i]);
      const key = first ? normalizeHeadingText(first[2]) : '';
      if (key) seen.add(key);
      continue;
    }

    // Тема-article H1 из середины чанка — снять ДО нормализатора.
    const h1 = /^ {0,3}#[ \t]+(.*?)[ \t]*$/.exec(lines[i]);
    if (h1 && topics.has(normalizeHeadingText(h1[1]))) {
      drop.add(i);
      continue;
    }

    const m = /^ {0,3}##[ \t]+(.*?)[ \t]*$/.exec(lines[i]);
    if (!m) continue;
    const key = normalizeHeadingText(m[1]);
    if (!key) continue;
    if (topics.has(key) || seen.has(key)) drop.add(i);
    else seen.add(key);
  }
  if (!drop.size) return { markdown, removed: 0 };
  return {
    markdown: lines.filter((_, idx) => !drop.has(idx)).join('\n'),
    removed: drop.size,
  };
}

/**
 * Собирает instruction-строку для одного батча секций.
 * @param {Array} sections — батч секций [{headingRu, purposeRu, keyPointsRu}]
 * @param {number} batchIndex — 0-based индекс батча
 * @param {number} totalBatches — всего батчей
 * @param {number} targetLength — целевая длина статьи
 */
function buildChunkInstruction(sections, batchIndex, totalBatches, targetLength) {
  const perSectionTarget = Math.max(800, Math.ceil(Number(targetLength) / Math.max(1, totalBatches * sections.length)));
  const sectionList = sections
    .map((section, index) => {
      if (typeof section === 'string') return `${index + 1}. ${section}`;
      const heading = normalizeText(section?.headingRu, `Раздел ${index + 1}`);
      const purpose = normalizeText(section?.purposeRu, '');
      const keyPoints = Array.isArray(section?.keyPointsRu) ? section.keyPointsRu : [];
      const kp = keyPoints.length ? ` (ключевые моменты: ${keyPoints.join('; ')})` : '';
      return `${index + 1}. ${heading}${purpose ? ` — ${purpose}` : ''}${kp}`;
    })
    .join('\n');

  return (
    `Напиши секции [${batchIndex * CHUNK_SECTION_SIZE + 1}-${batchIndex * CHUNK_SECTION_SIZE + sections.length}] ` +
    `из ${totalBatches} батча(ей) по структуре ниже. ` +
    `Каждая секция — минимум ${perSectionTarget} символов, это нижняя граница. ` +
    `Если получилось меньше — расширь каждый подпункт подробно: добавь пояснения, примеры, контекст и раскрытие каждого ключевого тезиса. ` +
    // U5: запрет служебных пометок продолжения — модель знала о батчах и
    // оставляла читателю «*(Продолжение следует в следующем батче...)*».
    `Заверши текущий фрагмент естественно. НЕ пиши служебных пометок: «Продолжение следует», «в следующем батче», номеров батчей в тексте. ` +
    `Батч ${batchIndex + 1} из ${totalBatches}.\n\nСтруктура секций этого батча:\n${sectionList}`
  );
}

/**
 * Оркеструет chunked-генерацию article-author: вызывает роль N раз по батчам
 * секций, склеивает все sectionMarkdownRu в единый articleMarkdownRu.
 *
 * Возвращает агрегированный structured-объект (как один вызов article-author):
 *   { titleRu, descriptionRu, articleMarkdownRu, faqRu, claimsForReviewRu, riskyPhrasesRu, _chunked: {...} }
 *
 * @param {object} args
 * @param {object} args.role — роль article-author (из agentRoleData)
 * @param {object} args.context — контекст пайплайна (с structureSections, authorDraft-полями)
 * @param {object} args.structuredOutputs — накопленные выходы (нужен structure-architect)
 * @param {string} args.articleId
 * @param {number} args.step — номер шага (для прогресса)
 * @returns {Promise<{ok:boolean, data?:object, error?:string, aggregated?:object}>}
 */
async function runChunkedArticleAuthor({ role, context, structuredOutputs, articleId, step }) {
  const structureData = structuredOutputs['structure-architect'] || {};
  const sections = Array.isArray(structureData.sectionsRu) ? structureData.sectionsRu : [];

  // Edge case: пустая структура или < 3 секций → caller должен делать single-call.
  if (sections.length < 3) {
    return { ok: false, fallbackToSingle: true };
  }

  const batches = batchSections(sections);
  if (!batches.length) {
    return { ok: false, fallbackToSingle: true };
  }

  console.log(
    `[Worker] Chunked article-author: ${sections.length} секций → ${batches.length} батч(ей) по ~${CHUNK_SECTION_SIZE} секции (targetLength=${context.articleLength}).`
  );

  // W1.2: кандидаты «темы статьи» для стрипа ведущих заголовков-тем в чанках 2+.
  // h1Ru структуры — плановый H1; articleTitle — тема из карточки статьи.
  const topicCandidates = [
    structureData?.h1Ru,
    context.articleTitle,
  ].filter((t) => typeof t === 'string' && t.trim());

  const collectedMarkdown = [];
  const collectedFaq = [];
  const collectedClaims = [];
  const collectedRisky = [];
  let titleRu = '';
  let descriptionRu = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostRub = 0;
  let strippedTopicHeadings = 0; // W1.2: сколько ведущих заголовков-тем снято
  const previousSectionSummaries = []; // для континуитета тона
  // G2: верхний стоп по объёму ('soft' | 'hard' | null) и число выполненных батчей.
  const chunkTargetLen = Number(context.articleLength) || 0;
  let volumeStop = null;
  let batchesDone = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    // G2/FIX-D2: накопленный объём ДО запроса очередного чанка; пороги — с
    // резервом хвоста (FAQ+подпись), чтобы финал не вылетал за 1.4× target.
    let finishMode = null;
    let stopCheckChars = 0;
    const stopRatios = chunkStopRatios(chunkTargetLen);
    if (chunkTargetLen > 0) {
      stopCheckChars = collectedMarkdown.join('\n\n').length;
      if (stopCheckChars >= chunkTargetLen * stopRatios.hard) finishMode = 'hard';
      else if (stopCheckChars >= chunkTargetLen * stopRatios.soft) finishMode = 'soft';
    }

    // Контекст для этого батча: переиспользуем base-context, но подсекаем
    // structureSections только этим батчем + добавляем instruction + previousSections.
    // G2 'hard': секции НЕ отправляем — принудительный завершающий вызов.
    const batchContext = {
      ...context,
      // Перекрываем structureSections только секциями этого батча, чтобы не
      // дёргать Dev-A-инъекцию полным массивом (G2 hard → пустой массив).
      structureSections: finishMode === 'hard' ? [] : batch,
      // max_tokens per-section: worker контролирует, не модель.
      maxTokens: SECTION_MAX_TOKENS,
      // previousSections (континуитет) — ОБРЕЗАННЫЕ summaries прошлых секций.
      // Прокидываем через qualityFeedback-независимое поле; используем
      // articleDraft как накопитель, чтобы Dev-A-инъекция подхватила.
    };

    // Сводка уже сгенерированных секций — в authorDraft, чтобы инъекция Dev-A
    // отрисовала её как «черновик» и модель видела континуитет.
    if (previousSectionSummaries.length) {
      batchContext.authorDraft = previousSectionSummaries.join('\n\n---\n\n');
    }

    const payload = buildRoleExecutionPayload({
      roleId: role.id,
      context: batchContext,
      criticalModel: CRITICAL_MODEL,
      generationModel: GENERATION_MODEL,
      standardModel: STANDARD_MODEL,
    });

    // Дописываем chunk-instruction в конец user-сообщения (после Dev-A сборки),
    // чтобы указать модели какой именно батч генерить. G2: soft — батчный
    // instruction + завершающая надбавка; hard — ТОЛЬКО принудительный вывод.
    if (payload.messages?.length) {
      const lastMsg = payload.messages[payload.messages.length - 1];
      if (lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string') {
        let instruction;
        if (finishMode === 'hard') {
          instruction = CHUNK_FORCED_FINISH_INSTRUCTION;
        } else {
          instruction = buildChunkInstruction(batch, b, batches.length, context.articleLength);
          if (finishMode === 'soft') {
            instruction += `\n\n${CHUNK_SOFT_FINISH_INSTRUCTION}`;
          }
        }
        lastMsg.content = `${lastMsg.content}\n\n---\n\n${instruction}`;
      }
    }

    let result;
    try {
      result = await callRouterAI(payload);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        aggregated: {
          totalInputTokens,
          totalOutputTokens,
          totalCostRub,
          batchesDone: b,
          totalBatches: batches.length,
        },
      };
    }

    const parsed = parseRoleExecutionResult({
      roleId: role.id,
      model: payload.model,
      response: result.data,
      // Передаём context для мягкой валидации claimsWithSourcesRu (evidence-слой).
      context,
    });

    const success =
      result.status >= 200 && result.status < 300
      && Boolean(parsed.content)
      // Truncation guard: if the model ran out of tokens mid-JSON, the content
      // may be present (raw truncated text) but the structured output is unusable.
      // Don't treat that as a successful section — let the caller retry / fall back.
      && !(parsed.finishReason === 'length' && !parsed.structured?.ok);

    // Auth/quota — не маскируем, пробрасываем наверх.
    if (!success && isAuthError(result.status)) {
      return { ok: false, error: authErrorMessage(result.status), authError: true, status: result.status };
    }

    if (!success) {
      return {
        ok: false,
        error: `Chunk ${b + 1}/${batches.length}: HTTP ${result.status} — модель не вернула содержательный ответ`,
        aggregated: {
          totalInputTokens,
          totalOutputTokens,
          totalCostRub,
          batchesDone: b,
          totalBatches: batches.length,
        },
      };
    }

    const data = parsed.structured?.data || parsed.parsed || {};
    let sectionMarkdown = normalizeText(
      data.sectionMarkdownRu || data.articleMarkdownRu,
      ''
    );
    if (sectionMarkdown) {
      // W1.2: чанки 2+ — снять ВЕДУЩИЕ заголовки-темы (H1/H2 ≈ тема статьи):
      // каждый батч эмитит свой `# {тема}`, normalizer понижает лишние H1 до
      // H2, а sanitizer дедуплит только смежные → разнесённые дубли (прод:
      // «Чистка лица» = тема ×4 в H2). Первый чанк сохраняет H1 темы.
      if (b > 0) {
        const stripped = stripLeadingTopicHeadings(sectionMarkdown, topicCandidates);
        if (stripped !== sectionMarkdown) {
          strippedTopicHeadings += 1;
          sectionMarkdown = stripped;
        }
      }
      collectedMarkdown.push(sectionMarkdown);
      previousSectionSummaries.push(summarizePrevSection(sectionMarkdown));
    }

    // Метаданные берём из первого батча (title/description) — модель генерит их на 1-м батче.
    if (b === 0) {
      titleRu = normalizeText(data.titleRu, '');
      descriptionRu = normalizeText(data.descriptionRu, '');
    }
    if (Array.isArray(data.faqRu)) collectedFaq.push(...data.faqRu);
    if (Array.isArray(data.claimsForReviewRu)) collectedClaims.push(...data.claimsForReviewRu);
    if (Array.isArray(data.riskyPhrasesRu)) collectedRisky.push(...data.riskyPhrasesRu);

    // Агрегация стоимости/токенов
    const usage = result.data?.usage || {};
    const inputTokens = usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0;
    totalInputTokens += Number(inputTokens) || 0;
    totalOutputTokens += Number(outputTokens) || 0;
    totalCostRub += calculateCostRub(inputTokens, outputTokens, payload.model);

    console.log(
      `[Worker] Chunked article-author батч ${b + 1}/${batches.length}: ${sectionMarkdown.length} chars, ${outputTokens} out tokens.`
    );

    batchesDone = b + 1;

    // G2: верхний стоп по объёму — после soft/hard-чанка секционные батчи
    // больше не запрашиваются (hard-вызов уже завершил статью выводом).
    if (finishMode) {
      volumeStop = finishMode;
      console.warn(
        `[Worker] Chunked article-author G2: объём ${stopCheckChars} chars на момент решения ≥ ` +
          `${finishMode === 'hard' ? Math.round(stopRatios.hard * 100) : Math.round(stopRatios.soft * 100)}% ` +
          `(порог с резервом хвоста ${CHUNK_TAIL_RESERVE_CHARS} симв.) targetLength=${chunkTargetLen} ` +
          `→ volumeStop=${finishMode}; батчей выполнено ${batchesDone}/${batches.length}.`
      );
      break;
    }
  }

  // U5 (2026-08-20): хвост-ONLY обрезка чанк-артефактов продолжения. Артефакт
  // («*(Продолжение следует в следующем батче...)*») живёт в хвосте НЕпоследних
  // чанков — модель знает, что дальше ещё батчи. Последний чанк не трогаем:
  // его хвост (если что) закрывает санитайзер финальной сборки. Только хвост,
  // середина текста неприкосновенна (реестр — article-sanitizer.mjs).
  let chunkArtifactsStripped = 0;
  for (let c = 0; c + 1 < collectedMarkdown.length; c += 1) {
    const stripped = stripTrailingContinuation(collectedMarkdown[c]);
    if (stripped !== collectedMarkdown[c]) {
      collectedMarkdown[c] = stripped;
      chunkArtifactsStripped += 1;
    }
  }
  if (chunkArtifactsStripped > 0) {
    console.warn(
      `[Worker] Chunked article-author U5: снято трейлинг-артефактов продолжения — ${chunkArtifactsStripped}/${collectedMarkdown.length - 1} чанк(ов).`
    );
  }

  let articleMarkdownRu = collectedMarkdown.join('\n\n');
  const targetLen = Number(context.articleLength) || 0;

  // W1.2: страховочный дедуп НЕСМЕЖНЫХ одинаковых H2 по всему документу
  // (keep-first, снимается только строка заголовка — контент сохраняется).
  // Дополнительно снимает H1-темы из СЕРЕДИНЫ чанков — ДО нормализатора:
  // heading-normalizer понизил бы их до H2 уже после этого дедупа.
  const dedupeH2 = dedupeNonAdjacentH2(articleMarkdownRu, topicCandidates);
  if (dedupeH2.removed > 0) {
    articleMarkdownRu = dedupeH2.markdown;
    console.warn(
      `[Worker] Chunked article-author W1.2: снято дубликатов H2 (keep-first) — ${dedupeH2.removed}; ведущих заголовков-темы в чанках 2+ — ${strippedTopicHeadings}.`
    );
  } else if (strippedTopicHeadings > 0) {
    console.warn(
      `[Worker] Chunked article-author W1.2: ведущих заголовков-темы снято в чанках 2+ — ${strippedTopicHeadings}.`
    );
  }

  // Post-check объёма: если недобор > 10% от targetLength — залогировать
  // предупреждение и поднять флаг lengthDeficit, чтобы воркер мог
  // (опционально) запустить добирающий батч или скорректировать пост-обработку.
  let lengthDeficit = false;
  if (targetLen > 0 && articleMarkdownRu.length < targetLen * 0.9) {
    lengthDeficit = true;
    console.warn(
      `[Worker] Chunked article-author: объём ${articleMarkdownRu.length} chars < 90% от targetLength=${targetLen} ` +
      `(дефицит ${targetLen - articleMarkdownRu.length} chars). lengthDeficit=true.`
    );
  }

  const aggregatedData = {
    titleRu,
    descriptionRu,
    articleMarkdownRu,
    faqRu: collectedFaq,
    claimsForReviewRu: collectedClaims,
    riskyPhrasesRu: collectedRisky,
    _chunked: {
      batches: batches.length,
      // G2: сколько реально выполнено (soft/hard-стоп обрывает серию раньше).
      batchesDone,
      volumeStop,
      totalInputTokens,
      totalOutputTokens,
      totalCostRub: Number(totalCostRub.toFixed(4)),
      sections: sections.length,
      sectionsPlanned: sections.length,
    },
  };

  return {
    ok: true,
    data: aggregatedData,
    aggregated: {
      totalInputTokens,
      totalOutputTokens,
      totalCostRub: Number(totalCostRub.toFixed(4)),
      batchesDone,
      totalBatches: batches.length,
      volumeStop,
      lengthDeficit,
      actualChars: articleMarkdownRu.length,
      targetChars: targetLen,
    },
  };
}


/* ------------------------------------------------------------------ */
/*  Основной обработчик job                                            */
/* ------------------------------------------------------------------ */

export async function processArticleGeneration(job) {
  const { articleId } = job.data;

  // Settings audit, P1-2: прогрев кэша правок промптов агентских
  // ролей ДОЛЖЕН завершиться до выполнения ролей. Прогрев на старте воркера
  // и на старте сервера — fire-and-forget, поэтому задача могла начаться
  // раньше, чем кэш прогрелся, и правки промптов молча не применились бы.
  // Здесь ждём загрузки; падение БД не роняет генерацию — тогда агенты
  // работают по статическому каталогу (server/agent-role-data.mjs).
  await loadAgentRoleOverrides().catch(() => {});

  console.log(`[Worker] Starting article generation: articleId=${articleId}, jobId=${job.id}`);

  // W-retry (2026-08-21): ретрай-цикл wall-clock-бюджета. attempt — номер
  // ПОЛНОГО прогона генерации внутри одного job (НЕ номер попытки очереди):
  // при исчерпании бюджета прогона (проверка между ролями/QC-итерациями) и
  // attempt < maxAttempts — статья сбрасывается к перегенерации тем же способом,
  // что POST /start (status → queued, needsReviewReason → null), а цикл
  // начинается заново: загрузка статьи, guard, контекст, research, роли —
  // ничего из старого прогона не переносится (контекст/structuredOutputs/
  // genTelemetry/qualityRetryCount объявлены ниже ВНУТРИ тела цикла).
  // На последней попытке — прежнее поведение W4.2 (finalizeWallClockExhausted:
  // контент + needs_review / failed). Каждый прогон сам конечен: QC ≤
  // MAX_QUALITY_RETRIES, фактчек-ревью ≤ MAX_FACTCHECK_REVIEW_PASSES, роли ≤
  // ретраи+цепочка → fallback-финализация (инварианты — в тестах).
  const maxAttempts = getGenerationMaxAttempts();

  attemptLoop: for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    /* 1. Загрузка статьи — topic-only (M2: FK источника убраны) */
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      include: {
        versions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!article) {
      throw unrecoverable(`Статья не найдена: ${articleId}`);
    }

    // W4.3 (2026-08-17): идемпотентность ретраев раннера. Если job был
    // доставлен повторно ПОСЛЕ успешной финализации (версия + постчек-ран
    // уже созданы), полный ролевой прогон лишь дублировал бы версии/служебные
    // раны и жёг токены. Статья в финальном статусе → выходим идемпотентно.
    // Частичный сбой посреди ролей (статус ещё «процессный») ретраится с
    // нуля как раньше — это честно: версий нет.
    // (M2: публикационных статусов больше нет — publishing OUT.)
    if (article.status === 'ready' || article.status === 'needs_review') {
      console.log(
        `[Worker] Article ${articleId} уже в финальном статусе «${article.status}» — повтор job ${job.id} выходит идемпотентно, без перегенерации.`
      );
      await job.updateProgress(100);
      return;
    }

    if (await checkStopped(articleId)) {
      console.log(`[Worker] Article ${articleId} is stopped before start, exiting cleanly`);
      return;
    }

    // W4.2: точка отсчёта wall-clock бюджета генерации.
    // W4.5: накопитель пер-ролевых записей для финального дайджеста.
    const genTelemetry = { startedAtMs: Date.now(), entries: [] };

    /* 2. Извлечение контекста — topic-only (M2: crawl-источник убран).
     * Идентичность компании — необязательная строка CompanyProfile:
     * name → siteName (упоминания/промпты/линкер), activeText → карточка
     * компании в контексте ролей. Профиля нет → обезличенный режим. */
    const companyProfile = await loadCompanyProfile();
    const activeText = typeof companyProfile?.activeText === 'string' ? companyProfile.activeText : '';
    const siteNameFromProfile = typeof companyProfile?.name === 'string' ? companyProfile.name.trim() : '';

    // ── M2: каталоги источника и сбор частотных ключей убраны ───────────────────
    // вместе с crawl/частотным источником. Промпт-блоки каталога/регламентов
    // условны (agent-role-execution): пустые массивы → блоки не рендерятся,
    // факт-грунтовка ложится на сохранённый evidence-слой (research, KEEP).


    const context = {
      // ────────────── M2: тема — единственный вход статьи. Карточки услуги/
      // специалиста/каталога убраны вместе с crawl-источником; пустые значения
      // держат швы промптов (блоки условны в agent-role-execution). ──
      sourceId: null,
      projectTitle: '',
      // seo-round TL (шов B1→A, M2-перебазировка): точное название компании —
      // из единственной строки CompanyProfile (профиль автора). При пустом
      // имени автор пишет «наша компания» обезличенно, а MENTIONS-SITE-COUNT
      // честно skip'ается (нет бренда — нечего считать).
      siteName: siteNameFromProfile,
      articleTitle: article.topic,
      specialistName: '',
      serviceName: '',
      priceLabel: '',
      servicePriceMin: null,
      servicePriceMax: null,
      servicePriceCurrency: null,
      serviceMarginPercent: null,
      serviceAvgCheckRub: null,
      serviceTrendDirection: null,
      serviceTrendNote: null,
      companyProfileText: activeText,
      articleLength: article.targetLength,
      serviceDescription: '',
      serviceIndications: '',
      serviceContraindications: '',
      serviceUrl: '',
      specialistPosition: '',
      specialistSpecialization: '',
      specialistExperience: '',
      specialistCredentials: '',
      specialistAuthorSignature: '',
      // ── B3 (2026-08-25): «Уточнения» владельца (article.userNotes; колонка
      // аддитивная, у старых строк null → ''). Рендерится ТОЛЬКО в payload
      // article-author + brief-preparer (agent-role-execution, showUserNotes).
      userNotes: typeof article.userNotes === 'string' ? article.userNotes : '',
      // ────────────────────────── D6 (GeneRaptor): язык материала статьи —
      // параметр генерации, хранится с статьёй ('ru' | 'en', дефолт ru) и
      // уезжает в промпты ролей (agent-role-execution, LANGUAGE_FORMAT_LINE).
      language: article.language === 'en' ? 'en' : 'ru',
      // ── Каталоги источника: пустые (M2 — crawl убран; блоки промптов условны) ──
      catalogServices: [],
      catalogSpecialists: [],
      catalogRegulations: [],
      // ── Внешние источники (evidence-слой) — заполняется перед запуском ролей ──
      externalResearch: [],
      researchData: null,
      // ── Передача полных черновиков между ролями (заполняются по ходу пайплайна) ──
      authorDraft: '',
      authorClaims: [],
      authorRiskyPhrases: [],
      structureSections: [],
      factcheckedDraft: '',
      factcheckedDraftRawWithCitations: '', // аудит-след с маркерами {{src:N}} (не идёт ролям)
      // ── Quality-gate retry-loop feedback (заполняется при перегенерации) ──
      qualityFeedback: '',
      previousOutputs: [],
    };

    const structuredOutputs = {};
    let qualityRetryCount = 0;

    // ── Сбор внешних источников (evidence-слой) ──
    // researchQuery общий для всех поисковых backend-ов: вынесен из
    // try/catch-блоков, чтобы каждый backend мог использовать его независимо.
    // M2: тема — единственный вход; service-поля убраны вместе с crawl.
    const researchQuery = [article.topic].filter(Boolean).join(' ').trim();

    // ── Сбор внешних источников (evidence-слой): единый web-search слой ──
    // Один контракт для всех backend-ов (keyless по умолчанию; Serper и Yandex —
    // опциональные платные). Только сниппеты: контент страниц не читаем.
    // Graceful: нет сети/ключа/квоты или блок keyless-бэкенда → warning,
    // генерация продолжается без внешних источников (никогда не 500).
    {
      if (!researchQuery) {
        console.log('[Worker] Web-search skipped (no query)');
      } else {
        try {
          console.log(`[Worker] Gathering web research for: "${researchQuery}"`);
          const outcome = await searchWeb({ query: researchQuery, limit: 5 });
          const provider = researchProviderFor(null, outcome.backend);
          const sources = outcome.results.map((r) => normalizeResearchSource({
            // The provider of the ITEM wins: a narrow vertical source must not
            // be stored under the name of the main engine.
            provider: researchProviderFor(r, outcome.backend),
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            extractedText: r.snippet, // snippet-only, без fetch контента
            evidenceLevel: 'medium',
            query: researchQuery,
          }));
          if (sources.length) {
            await persistResearchSources(articleId, sources.map((r) => ({
              articleId,
              provider: r.provider,
              query: r.query,
              sourceUrl: r.sourceUrl,
              normalizedUrl: normalizedUrlOrNull(r.sourceUrl),
              title: r.title,
              snippet: r.snippet,
              extractedText: r.extractedText,
              evidenceLevel: r.evidenceLevel,
              metadata: serializeResearchMetadata(r.metadata),
            })));
            context.externalResearch.push(...sources);
            console.log(`[Worker] Web-search (${provider}): ${sources.length} sources (snippet-only)`);
          } else {
            console.log(
              `[Worker] Web-search: 0 results (degraded=${outcome.degraded}, reason=${outcome.reason || 'none'})`
            );
          }
        } catch (e) {
          console.warn(`[Worker] Web-search failed (non-blocking): ${e.message}`);
        }
      }
    }

    // ── Адаптивное расширение источников + ИИ-консенсус ──
    // Если нет canon/high источников → расширяем Yandex + строим консенсус.
    // Consensus facts (≥2 источника согласны) → synthetic 'high' sources для фактчекера.
    const hasCanonHigh = context.externalResearch.some(
      s => s.evidenceLevel === 'canon' || s.evidenceLevel === 'high'
    );
    if (!hasCanonHigh && researchQuery && context.externalResearch.length >= 2) {
      // FIX 2026-07-10: расширено для больших статей. Было MAX_ROUNDS=2, TARGET_FACTS=3
      // → фактчекер вырезал 32k автора до 5.8k (мало подтверждённых фактов для 60k).
      // Теперь: до 5 раундов (макс ~30 источников), цель 10+ consensus facts.
      const MAX_ROUNDS = Number(process.env.CONSENSUS_MAX_ROUNDS ?? 5);
      const TARGET_FACTS = Number(process.env.CONSENSUS_MIN_FACTS ?? 10);
      const MIN_SUPPORT = Number(process.env.CONSENSUS_MIN_SUPPORT ?? 2);

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        console.log(`[Worker] Консенсус round ${round}/${MAX_ROUNDS}: расширяем источники на +5`);

        // +5 источников (page=round). Пагинацию поддерживают не все
        // бэкенды (DuckDuckGo/Yandex — opt-in; Serper/Tavily/Wikipedia — нет),
        // поэтому раунд без НОВЫХ ссылок останавливает расширение ниже —
        // повторные одинаковые выдачи больше не жгут квоту и не плодят дубли.
        let addedNew = 0;
        try {
          const outcome = await searchWeb({ query: researchQuery, limit: 5, page: round });
          const provider = researchProviderFor(null, outcome.backend);
          const candidates = (outcome.results || []).slice(0, 5).map(r => normalizeResearchSource({
            provider: researchProviderFor(r, outcome.backend),
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            extractedText: r.snippet,
            evidenceLevel: 'medium',
            query: researchQuery,
          }));
          // Только невиданные подписи идут в БД и в консенсус — дубли
          // одного URL больше не раздувают supportCount.
          const seenBefore = new Set(
            context.externalResearch
              .map(s => s.normalizedUrl || canonicalSignature(s.sourceUrl))
              .filter(Boolean),
          );
          const { fresh } = splitNewSources(candidates, seenBefore);
          addedNew = fresh.length;
          if (fresh.length) {
            await persistResearchSources(articleId, fresh.map(r => ({
              articleId, provider: r.provider, query: r.query,
              sourceUrl: r.sourceUrl, normalizedUrl: normalizedUrlOrNull(r.sourceUrl),
              title: r.title, snippet: r.snippet,
              extractedText: r.extractedText, evidenceLevel: r.evidenceLevel,
            })));
            context.externalResearch.push(...fresh);
            console.log(`[Worker] Консенсус round ${round}: +${fresh.length} (${provider}), всего ${context.externalResearch.length}`);
          }
        } catch (e) {
          console.warn(`[Worker] Консенсус round ${round}: расширение источников не удалось (non-blocking): ${e.message}`);
        }

        // Консенсус-анализ всех источников
        try {
          const { syntheticSources } = await buildConsensus(context.externalResearch, {
            callRouterAI,
            minSupport: MIN_SUPPORT,
          });

          // Сохранить synthetic sources в БД
          if (syntheticSources.length) {
            await persistResearchSources(articleId, syntheticSources.map(r => ({
              articleId, provider: 'consensus', query: researchQuery,
              sourceUrl: r.sourceUrl, normalizedUrl: normalizedUrlOrNull(r.sourceUrl),
              title: r.title, snippet: r.snippet,
              extractedText: r.extractedText, evidenceLevel: r.evidenceLevel,
              metadata: serializeResearchMetadata(r.metadata),
            })));
          }

          // Удалить старые synthetic consensus sources из externalResearch (если были из прошлого раунда)
          context.externalResearch = context.externalResearch.filter(s => s.provider !== 'consensus');
          context.externalResearch.push(...syntheticSources);

          console.log(`[Worker] Консенсус round ${round}: ${syntheticSources.length} facts (evidenceLevel high, support ≥${MIN_SUPPORT})`);

          if (syntheticSources.length >= TARGET_FACTS) {
            console.log(`[Worker] Консенсус: цель достигнута (${syntheticSources.length} ≥ ${TARGET_FACTS}), остановка`);
            break;
          }
          // Раунд не дал ни одной новой ссылки (в т.ч. сбой поиска или
          // пустая выдача) → расширение остановлено. Стоп стоит ПОСЛЕ
          // buildConsensus и сохранения synthetic-источников этого раунда,
          // чтобы консенсус раунда не потерялся; цель по фактам выше — первая.
          if (addedNew === 0) {
            console.log(`[Worker] Консенсус round ${round}: новых источников нет — расширение остановлено`);
            break;
          }
          if (round === MAX_ROUNDS) {
            console.log(`[Worker] Консенсус: максимум раундов, итог ${syntheticSources.length} facts`);
          }
        } catch (e) {
          console.warn(`[Worker] Консенсус round ${round}: builder failed (non-blocking): ${e.message}`);
          break;
        }
      }
    } else if (!hasCanonHigh) {
      console.log('[Worker] Консенсус пропущен: недостаточно источников или нет researchQuery');
    } else {
      console.log('[Worker] Консенсус не нужен: есть canon/high источники');
    }

    /* 3. Последовательный запуск ролей */
    for (let i = 0; i < agentRoleData.length; i++) {
      const role = agentRoleData[i];
      const step = i + 1;

      /* Проверка остановки перед каждой ролью */
      if (await checkStopped(articleId)) {
        console.log(`[Worker] Article ${articleId} stopped at stage ${step}, exiting cleanly`);
        return;
      }

      /* W4.2 + W-retry: wall-clock бюджет прогона — проверка между ролями и
         итерациями QC (внутри LLM-вызова свой бюджет W1.5). 0/'off' → проверка
         отключена. Исчерпан и попытки ещё есть → свежий прогон (reset как
         POST /start); исчерпан на последней попытке → честная финализация. */
      const wallClockBudgetMs = getGenerationWallClockMs();
      if (wallClockBudgetMs > 0 && Date.now() - genTelemetry.startedAtMs >= wallClockBudgetMs) {
        if (attempt < maxAttempts) {
          const elapsedMs = Date.now() - genTelemetry.startedAtMs;
          console.warn(
            `[wall-clock] попытка ${attempt} исчерпана — перезапуск генерации ` +
            `(попытка ${attempt + 1}/${maxAttempts}): articleId=${articleId}, ` +
            `${elapsedMs}ms ≥ ${wallClockBudgetMs}ms — стоп перед ролью «${role?.nameRu || '?'}» (шаг ${step}).`
          );
          // Reset к перегенерации — тем же способом, что POST /start (роут
          // articles.mjs): процессный статус + сброс причины needs_review.
          // БД-артефакты прогона (AgentRuns) остаются как аудит-след, версии не
          // создавались (saveFinalVersion не вызывался) — дублей нет. Guard
          // W4.3 на 'queued' пропускает следующий прогон, а финальные статусы
          // (ready/needs_review) по-прежнему блокируют внешний повторный enqueue.
          await prisma.article.update({
            where: { id: articleId },
            data: { status: 'queued', needsReviewReason: null },
          });
          continue attemptLoop;
        }
        await finalizeWallClockExhausted(article, articleId, structuredOutputs, job, {
          role,
          step,
          genTelemetry,
          maxAttempts,
        });
        return;
      }

      /* Обновление прогресса job */
      await job.updateProgress(Math.round((i / TOTAL_STAGES) * 100));

      /* Обновление статуса статьи */
      const articleStatus = ROLE_STATUS_MAP[role.id] || 'processing';
      await prisma.article.update({
        where: { id: articleId },
        // U3: первый per-role апдейт нового прогона — сброс причины needs_review
        // прошлого прогона (/start-рестарт; QC/wall-clock/enforce могли её оставить).
        data: { status: articleStatus, needsReviewReason: null },
      });

      /* ── Chunked generation для article-author (статьи 20k+ chars) ──
         Один вызов на 50k chars упирается в max_tokens модели + `fetch failed`
         на длинных keep-alive. Разбиваем по секциям структуры, склеиваем в worker.
         Условие: targetLength >= CHUNK_THRESHOLD И structure.sectionsRu >= 3.
         Если условие не выполнено — fallback на single-call ниже. */
      const useChunked =
        role.id === 'article-author' &&
        Number(context.articleLength) >= CHUNK_THRESHOLD &&
        Array.isArray(context.structureSections) &&
        context.structureSections.length >= 3;

      if (useChunked) {
        // Создаём ОДИН AgentRun для article-author (агрегируем все батчи в него).
        const chunkAgentRun = await prisma.agentRun.create({
          data: {
            articleId,
            agentName: role.nameRu,
            status: 'running',
            progress: 0,
            inputJson: JSON.stringify({ chunked: true, sections: context.structureSections.length, articleLength: context.articleLength }),
            startedAt: new Date(),
          },
        });

        sendProgress(
          buildProgressPayload({
            articleId,
            currentStage: step,
            stageName: role.nameRu,
            agentName: role.id,
            description: `${role.nameRu} (chunked: ${context.structureSections.length} секций)`,
            percent: Math.round((i / TOTAL_STAGES) * 100),
            status: 'running',
          })
        );

        const chunkStartedAtMs = Date.now();
        const chunkResult = await runChunkedArticleAuthor({
          role,
          context,
          structuredOutputs,
          articleId,
          step,
        });

        /** W4.5: запись дайджеста для chunked-прогонa автора. */
        const pushChunkDigest = (status) => {
          genTelemetry.entries.push({
            roleId: role.id,
            ms: Date.now() - chunkStartedAtMs,
            status,
            retries: 0,
            fallbackModel: null,
          });
        };

        // Edge case: структура < 3 секций → fallback на single-call.
        if (chunkResult.fallbackToSingle) {
          console.log(`[Worker] Chunked article-author → fallback на single-call (секций < 3).`);
          // Не падаем — продолжаем на обычный путь ниже (не делаем continue).
          // Помечаем AgentRun как неактуальный, single-call создаст новый.
          await prisma.agentRun.update({
            where: { id: chunkAgentRun.id },
            data: {
              status: 'completed',
              error: 'chunked skipped (sections < 3) → single-call',
              finishedAt: new Date(),
            },
          });
        } else if (!chunkResult.ok) {
          // Auth/quota — пробрасываем наверх как failure.
          if (chunkResult.authError) {
            pushChunkDigest('failed');
            await prisma.agentRun.update({
              where: { id: chunkAgentRun.id },
              data: { status: 'failed', error: chunkResult.error, finishedAt: new Date() },
            });
            await prisma.article.update({ where: { id: articleId }, data: { status: 'failed', needsReviewReason: null } });
            sendProgress(
              buildProgressPayload({
                articleId,
                currentStage: step,
                stageName: role.nameRu,
                agentName: role.id,
                description: `${role.nameRu}: ошибка авторизации`,
                percent: Math.round((i / TOTAL_STAGES) * 100),
                status: 'error',
                message: chunkResult.error,
              })
            );
            throw unrecoverable(`Роль «${role.nameRu}»: ${chunkResult.error}`);
          }

          // Transient-ошибка во время chunking → fallback на single-call путь ниже.
          // article-author single-call сам имеет fallback-ветку (generateFallbackArticle),
          // а с W4.1 single-call защищён ещё и цепочкой резервных моделей.
          console.error(
            `[Worker] Chunked article-author упал (${chunkResult.error}), переходим на single-call/fallback путь.`
          );
          pushChunkDigest('failed');
          await prisma.agentRun.update({
            where: { id: chunkAgentRun.id },
            data: {
              status: 'failed',
              error: `chunked failed: ${chunkResult.error}`,
              finishedAt: new Date(),
            },
          });
          // Идём на обычный single-call ниже (не continue).
        } else {
          // Успех chunking: агрегируем в ОДИН AgentRun + structuredOutput.
          const agg = chunkResult.aggregated || {};
          let aggregatedData = chunkResult.data;

          // Пост-обработка агрегированной статьи (метрики объёма; U4: FAQ-вставка удалена)
          try {
            const { postProcessArticle } = await import('../article-post-processor.mjs');
            const ppResult = postProcessArticle({
              parsed: aggregatedData,
              targetLength: context.articleLength,
              keyPoints: collectKeyPointsFromStructure(structuredOutputs['structure-architect']),
            });
            if (ppResult.ok) {
              aggregatedData = ppResult.result.parsed;
              console.log(
                `[Worker] Post-process chunked article-author: chars=${ppResult.result.postProcessed?.totalChars}/${ppResult.result.postProcessed?.targetChars}, shortSections=${ppResult.result.postProcessed?.shortSections?.length ?? 0}`
              );
            }
          } catch (ppErr) {
            console.error('[Worker] Post-process chunked article-author error:', ppErr.message);
          }

          structuredOutputs['article-author'] = aggregatedData;

          await prisma.agentRun.update({
            where: { id: chunkAgentRun.id },
            data: {
              status: 'completed',
              progress: 100,
              outputJson: JSON.stringify({
                content: aggregatedData.articleMarkdownRu,
                structured: { hasContract: true, ok: true, data: aggregatedData },
                chunked: aggregatedData._chunked,
                // W4.1: какая модель исполнила роль (аддитивно; chunked-батчи
                // все идут на generation-модель тира автора, цепочка не применяется).
                model: GENERATION_MODEL,
                finishReason: 'stop',
              }),
              inputTokens: agg.totalInputTokens || 0,
              outputTokens: agg.totalOutputTokens || 0,
              costRub: agg.totalCostRub || 0,
              finishedAt: new Date(),
            },
          });

          // Прокидываем ПОЛНЫЙ черновик автора в context для factchecker'а.
          context.authorDraft = aggregatedData.articleMarkdownRu || '';
          context.authorClaims = Array.isArray(aggregatedData.claimsForReviewRu)
            ? aggregatedData.claimsForReviewRu
            : [];
          context.authorRiskyPhrases = Array.isArray(aggregatedData.riskyPhrasesRu)
            ? aggregatedData.riskyPhrasesRu
            : [];

          context.previousOutputs.push({
            roleId: role.id,
            roleNameRu: role.nameRu,
            summaryRu: `Chunked-черк: ${aggregatedData.articleMarkdownRu?.length || 0} символов, ${agg.totalBatches || 0} батч(ей)`,
          });

          sendProgress(
            buildProgressPayload({
              articleId,
              currentStage: step,
              stageName: role.nameRu,
              agentName: role.id,
              description: `${role.nameRu} (chunked готов)`,
              percent: Math.round((step / TOTAL_STAGES) * 100),
              // Прогон продолжается (дальше — фактчекер и др.) → статус прогона
              // остаётся 'running'; 'completed' зарезервирован за финальным кадром.
              status: 'running',
              message: `Chunked-генерация: ${aggregatedData.articleMarkdownRu?.length || 0} символов из ${context.structureSections.length} секций`,
            })
          );

          pushChunkDigest('ok');
          continue; // article-author отработал chunked-путём — к следующей роли
        }
      }

      /* Сборка payload для LLM */
      const payload = buildRoleExecutionPayload({
        roleId: role.id,
        context,
        criticalModel: CRITICAL_MODEL,
        generationModel: GENERATION_MODEL,
        standardModel: STANDARD_MODEL,
      });

      /* Создание записи AgentRun (статус running) */
      const agentRun = await prisma.agentRun.create({
        data: {
          articleId,
          agentName: role.nameRu,
          status: 'running',
          progress: 0,
          inputJson: JSON.stringify(payload),
          startedAt: new Date(),
        },
      });

      /* WebSocket: начало роли */
      sendProgress(
        buildProgressPayload({
          articleId,
          currentStage: step,
          stageName: role.nameRu,
          agentName: role.id,
          description: role.nameRu,
          percent: Math.round((i / TOTAL_STAGES) * 100),
          status: 'running',
        })
      );

      /* Реальный вызов RouterAI.
         W4.1 (2026-08-17): вызов обёрнут цепочкой резервных моделей — при
         исчерпании ретраев первичного звена (внутри callRouterAI, W1.5) роль
         повторяется следующей моделью tier-цепочки (critical→generation,
         generation→standard, standard→STOP). Контракт возврата идентичен
         callRouterAI (result ИЛИ throw), все существующие fallback-пути воркера
         не меняются; thinking-флаги/max_tokens сохраняются на любом звене
         (клонится payload с заменой только model); kill-switch —
         ROUTERAI_FALLBACK_CHAIN=off. roleChainInfo (out) — реально исполнившая
         модель для AgentRun-журнала и дайджеста. */
      const roleStartedAtMs = Date.now();
      const roleChainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };
      let result;
      let fetchError = null;
      try {
        result = await callRouterAIWithFallbackChain(payload, {
          roleId: role.id,
          generationModel: GENERATION_MODEL,
          standardModel: STANDARD_MODEL,
          chainInfo: roleChainInfo,
        });
      } catch (error) {
        fetchError = error;
      }

      /* Fallback для article-author при transient-ошибках (502 / fetch failed).
         Auth/quota-ошибки (401/402/403) НЕ должны маскироваться fallback'ом —
         пользователь увидит реальную причину, а не «успешный» шаблон. */
      if (role.id === 'article-author' && isFallbackEligible(fetchError, result?.status)) {
        const errorMessage = fetchError instanceof Error ? fetchError.message : `HTTP ${result?.status}`;
        console.error(
          `[Worker] article-author упал (${errorMessage}), генерируем fallback из структуры...`
        );

        let fallbackData = generateFallbackArticle(structuredOutputs['structure-architect'], {
          articleTitle: context.articleTitle,
          projectTitle: context.projectTitle,
          specialistName: context.specialistName,
          priceLabel: context.priceLabel,
        });

        // Пост-обработка fallback: метрики объёма (U4: FAQ-вставка удалена)
        const { postProcessArticle } = await import('../article-post-processor.mjs');
        const ppResult = postProcessArticle({
          parsed: fallbackData,
          targetLength: context.articleLength,
          keyPoints: collectKeyPointsFromStructure(structuredOutputs['structure-architect']),
        });
        if (ppResult.ok) {
          fallbackData = ppResult.result.parsed;
          console.log(
            `[Worker] Post-process fallback article-author: chars=${ppResult.result.postProcessed?.totalChars}/${ppResult.result.postProcessed?.targetChars}, shortSections=${ppResult.result.postProcessed?.shortSections?.length ?? 0}`
          );
        }

        // FIX-M2 (2026-08-17): помечаем ШАБЛОН — иначе ключ в structuredOutputs
        // неотличим от живого автора, и позднейший fallback (напр., таймаут
        // фактчекера) с skipFaq=false дёргал бы FAQ-генератор по мёртвому
        // провайдеру (~9 мин ожидания до fail-safe).
        fallbackData._fallbackTemplate = true;
        structuredOutputs['article-author'] = fallbackData;

        await prisma.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: 'completed',
            error: `fallback: ${errorMessage}`,
            outputJson: JSON.stringify({
              fallback: true,
              error: errorMessage,
              content: fallbackData,
              // W4.1: модель, на которой роль упала перед шаблонной деградацией.
              model: roleChainInfo.model,
            }),
            finishedAt: new Date(),
          },
        });

        sendProgress(
          buildProgressPayload({
            articleId,
            currentStage: step,
            stageName: role.nameRu,
            agentName: role.id,
            description: `${role.nameRu} (fallback-генерация)`,
            percent: Math.round((step / TOTAL_STAGES) * 100),
            // Прогон продолжается → статус прогона 'running' (см. контракт
            // WS-кадра прогресса выше); 'completed' — только финальный кадр.
            status: 'running',
            message: `Fallback-генерация из структуры (${fallbackData._fallbackWordCount} слов)`,
          })
        );

        // Сохраняем артефакт роли для следующих ролей
        const summary = fallbackData.articleMarkdownRu
          ? fallbackData.articleMarkdownRu.slice(0, 200)
          : 'fallback-генерация из структуры';
        context.previousOutputs.push({
          roleId: role.id,
          roleNameRu: role.nameRu,
          summaryRu: summary,
        });

        // Фикс бага: фактчекеру нужен ПОЛНЫЙ черновик автора, а не ≤200-char summary
        context.authorDraft = fallbackData.articleMarkdownRu || '';
        context.authorClaims = Array.isArray(fallbackData.claimsForReviewRu)
          ? fallbackData.claimsForReviewRu
          : [];
        context.authorRiskyPhrases = Array.isArray(fallbackData.riskyPhrasesRu)
          ? fallbackData.riskyPhrasesRu
          : [];

        // Продолжаем pipeline: factchecker, seo-reviewer, quality-controller, humanizer
        // W4.5: роль завершена шаблонным fallback'ом — фиксируем в дайджесте.
        genTelemetry.entries.push({
          roleId: role.id,
          ms: Date.now() - roleStartedAtMs,
          status: 'fallback',
          retries: roleChainInfo.failedAttempts,
          fallbackModel: roleChainInfo.fallbackModel,
        });
        continue;
      }

      /* Обработка сетевой ошибки (не article-author) */
      if (fetchError) {
        const errorMessage = fetchError instanceof Error ? fetchError.message : 'Ошибка сети при вызове RouterAI';

        // W4.5: сетевой сбой роли (после исчерпания цепочки W4.1) — в дайджест.
        genTelemetry.entries.push({
          roleId: role.id,
          ms: Date.now() - roleStartedAtMs,
          status: 'failed',
          retries: roleChainInfo.failedAttempts,
          fallbackModel: roleChainInfo.fallbackModel,
        });

        // Fallback: если LLM недоступен или у нас уже есть fallback-контент статьи — сохраняем статью
        if (isFallbackEligible(fetchError) || structuredOutputs['article-author']) {
          await prisma.agentRun.update({
            where: { id: agentRun.id },
            data: {
              status: 'completed',
              error: `fallback: ${errorMessage}`,
              finishedAt: new Date(),
            },
          });
          await finalizeWithFallback(article, articleId, structuredOutputs, job, errorMessage, genTelemetry);
          return;
        }

        await prisma.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: 'failed',
            error: errorMessage,
            finishedAt: new Date(),
          },
        });

        await prisma.article.update({
          where: { id: articleId },
          data: { status: 'failed', needsReviewReason: null },
        });

        sendProgress(
          buildProgressPayload({
            articleId,
            currentStage: step,
            stageName: role.nameRu,
            agentName: role.id,
            description: `${role.nameRu}: ошибка`,
            percent: Math.round((i / TOTAL_STAGES) * 100),
            status: 'error',
            message: errorMessage,
          })
        );

        throw unrecoverable(`Роль «${role.nameRu}» завершилась с ошибкой: ${errorMessage}`);
      }

      /* Парсинг ответа */
      const parsed = parseRoleExecutionResult({
        roleId: role.id,
        model: payload.model,
        response: result.data,
        // Передаём context для мягкой валидации claimsWithSourcesRu (evidence-слой).
        context,
      });

      const success = result.status >= 200 && result.status < 300 && Boolean(parsed.content);

      // If the model returned 2xx but content is empty, give a useful reason.
      // The most common cause is max_tokens truncation on reasoning models: the
      // reasoning phase consumes the entire token budget before any content is
      // emitted (finish_reason === 'length').
      const emptyContentReason = (!success && parsed.finishReason === 'length')
        ? `Превышён лимит токенов (finish_reason=length): модель не успела сгенерировать ответ. Проверьте max_tokens для роли «${role.nameRu}».`
        : `HTTP ${result.status}: модель не вернула содержательный ответ`;

      /* Извлечение токенов и расчёт стоимости */
      const usage = result.data?.usage || {};
      const inputTokens =
        usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0;
      const outputTokens =
        usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0;
      const costRub = calculateCostRub(inputTokens, outputTokens, payload.model);

      /* Обновление AgentRun с результатом */
      await prisma.agentRun.update({
        where: { id: agentRun.id },
        data: {
          status: success ? 'completed' : 'failed',
          progress: 100,
          outputJson: JSON.stringify({
            content: parsed.content,
            structured: parsed.structured,
            finishReason: parsed.finishReason,
            usage: parsed.usage,
            // W4.1 (аддитивно, контракт не ломаем): какая модель ИСПОЛНИЛА роль.
            // При деградации цепочки — резервная модель звена, иначе первичная.
            model: roleChainInfo.model,
          }),
          error: success ? null : emptyContentReason,
          inputTokens,
          outputTokens,
          costRub,
          finishedAt: new Date(),
        },
      });

      // W4.5: пер-ролевая запись дайджеста — сразу после факта исполнения роли,
      // до ветвления success/!success, чтобы failed- и fallback-исходы тоже
      // попадали в финальный [gen-digest].
      genTelemetry.entries.push({
        roleId: role.id,
        ms: Date.now() - roleStartedAtMs,
        status: success ? 'ok' : 'failed',
        retries: roleChainInfo.failedAttempts,
        fallbackModel: roleChainInfo.fallbackModel,
      });

      /* Накопление выходов для следующих ролей */
      const summary =
        parsed.structuredSummaryRu || (parsed.content ? parsed.content.slice(0, 200) : 'нет данных');
      if (parsed.structured?.data) {
        structuredOutputs[role.id] = parsed.structured.data;
      }

      /* Post-processing для article-author: метрики объёма (U4: FAQ-вставка удалена) */
      if (role.id === 'article-author' && parsed.structured?.data) {
        const { postProcessArticle } = await import('../article-post-processor.mjs');
        const ppResult = postProcessArticle({
          parsed: parsed.structured.data,
          targetLength: context.articleLength,
          keyPoints: collectKeyPointsFromStructure(structuredOutputs['structure-architect']),
        });
        if (ppResult.ok) {
          structuredOutputs[role.id] = ppResult.result.parsed;
          console.log(
            `[Worker] Post-process article-author: chars=${ppResult.result.postProcessed?.totalChars}/${ppResult.result.postProcessed?.targetChars}, shortSections=${ppResult.result.postProcessed?.shortSections?.length ?? 0}`
          );
        }
      }

      context.previousOutputs.push({
        roleId: role.id,
        roleNameRu: role.nameRu,
        summaryRu: summary,
      });

      /* ── Прокидываем ПОЛНЫЕ черновики в context для следующих ролей ──
         (фикс бага: раньше между ролями шёл только ≤200-char summary) */
      const structuredData = structuredOutputs[role.id];
      if (structuredData) {
        if (role.id === 'structure-architect') {
          // Полная структура (без обрезки до 3) — нужна article-author
          context.structureSections = Array.isArray(structuredData.sectionsRu)
            ? structuredData.sectionsRu
            : [];
        }
        if (role.id === 'article-author') {
          // Полный черновик + claims + risky phrases — нужны factchecker'у
          context.authorDraft = structuredData.articleMarkdownRu || '';
          context.authorClaims = Array.isArray(structuredData.claimsForReviewRu)
            ? structuredData.claimsForReviewRu
            : [];
          context.authorRiskyPhrases = Array.isArray(structuredData.riskyPhrasesRu)
            ? structuredData.riskyPhrasesRu
            : [];
        }
        if (role.id === 'factchecker') {
          // Полный проверенный черновик — нужен humanizer'у для стилизации именно этой версии.
          // ── Perplexity-логика (ADDENDUM 2026-07-10): strip inline-маркеров {{src:N}} ──
          // AgentRun.outputJson уже сохранил ИСХОДНЫЙ checkedArticleMarkdownRu с маркерами
          // (обновление выше, строки ~1185) — это аудит-след. Здесь же снимаем маркеры:
          // humanizer и все последующие роли (seo-reviewer, quality-controller)
          // получают текст БЕЗ маркеров. Финальная статья тоже без маркеров.
          const factcheckedRaw = structuredData.checkedArticleMarkdownRu || '';
          // Оригинал с маркерами — в отдельное поле, НЕ идёт ролям (только аудит/диагностика).
          context.factcheckedDraftRawWithCitations = factcheckedRaw;
          // Версия БЕЗ маркеров — для humanizer и последующих ролей.
          context.factcheckedDraft = stripCitations(factcheckedRaw);
          // Также чистим structuredOutputs, чтобы extractFinalArticle (fallback-контент,
          // если humanizer не отработал) был без маркеров.
          if (factcheckedRaw) {
            structuredData.checkedArticleMarkdownRu = stripCitations(factcheckedRaw);
          }
        }
        if (role.id === 'research-analyst') {
          // Сохраняем структурированный вывод research-analyst для последующих ролей.
          context.researchData = structuredData;
        }
        if (role.id === 'semantic-strategist') {
          // ── P1 (2026-08-16): SEO-ядро для structure-architect + seo-reviewer ──
          // Архитектор заголовков и SEO-ревьюер раньше получали лишь lossy-summary
          // семантики (первые 3 поля × 3 элемента, faqIntentsRu терялся). Прокидываем
          // компактную выжимку (сечки seo-standards в buildSemanticCoreContext)
          // из structuredOutputs semantic-стратегиста — M2: он единственный
          // поставщик ядра (частотный источник убран).
          // Рендер в payload — только этим двум ролям (см. agent-role-execution.mjs),
          // payload остальных ролей не растёт. semantic-strategist НЕ входит в
          // QUALITY_RESET_ROLES и не сбрасывается в retry-блоке ниже → ядро
          // переживает перегенерации с article-author.
          const { buildSemanticCoreContext } = await import('../agent-role-execution.mjs');
          context.semanticCore = buildSemanticCoreContext(
            structuredData,
            article.targetLength
          );
        }
      }

      /* WebSocket: завершение роли */
      sendProgress(
        buildProgressPayload({
          articleId,
          currentStage: step,
          stageName: role.nameRu,
          agentName: role.id,
          description: role.nameRu,
          percent: Math.round((step / TOTAL_STAGES) * 100),
          // Роль завершена, но ПРОГОН продолжается → статус прогона 'running'.
          // 'completed' означает «прогон завершён» и остаётся только за
          // финальным кадром (см. контракт WS-кадра прогресса выше).
          status: success ? 'running' : 'error',
          message: success ? undefined : emptyContentReason,
        })
      );

      if (!success) {
        // Auth/quota errors (401/402/403) must surface as failures, not silent fallbacks.
        if (isAuthError(result.status)) {
          const authMsg = authErrorMessage(result.status);
          await prisma.agentRun.update({
            where: { id: agentRun.id },
            data: { status: 'failed', error: authMsg, finishedAt: new Date() },
          });
          await prisma.article.update({ where: { id: articleId }, data: { status: 'failed', needsReviewReason: null } });
          sendProgress(
            buildProgressPayload({
              articleId,
              currentStage: step,
              stageName: role.nameRu,
              agentName: role.id,
              description: `${role.nameRu}: ошибка авторизации`,
              percent: Math.round((i / TOTAL_STAGES) * 100),
              status: 'error',
              message: authMsg,
            })
          );
          throw unrecoverable(`Роль «${role.nameRu}»: ${authMsg}`);
        }

        // Fallback при transient HTTP-ошибках LLM (502, 5xx) или если уже есть article-author контент
        if (isFallbackEligible(null, result.status) || structuredOutputs['article-author']) {
          const reason = `HTTP ${result.status}: модель не вернула содержательный ответ`;
          await prisma.agentRun.update({
            where: { id: agentRun.id },
            data: {
              status: 'completed',
              error: `fallback: ${reason}`,
              finishedAt: new Date(),
            },
          });
          await finalizeWithFallback(article, articleId, structuredOutputs, job, reason, genTelemetry);
          return;
        }

        await prisma.article.update({
          where: { id: articleId },
          data: { status: 'failed', needsReviewReason: null },
        });

        throw unrecoverable(
          `Роль «${role.nameRu}» завершилась с ошибкой (HTTP ${result.status}). Модель не вернула содержательный ответ.`
        );
      }

      /* ── Quality-gate retry-loop (после quality-controller) ──
         Проверяем вердикт качества и фактчекинга. Если качество НЕ прошло —
         перегенерируем с article-author (с feedback), в пределах MAX_QUALITY_RETRIES.
         Сбрасываем только выходы ролей после structure-architect; context-сборка
         Dev-A до цикла не трогается. */
      if (role.id === 'quality-controller' && parsed?.structured?.data) {
        const qcData = parsed.structured.data;
        const fcData = structuredOutputs['factchecker'] || {};
        const qcBlocked =
          qcData.finalizationAllowed === false ||
          qcData.finalizationAllowed === 'false';
        const fcReviewRequired = fcData.reviewRequired === true;
        // W1.1: reviewRequired блокирует финализацию только пока автор не
        // исчерпал лимит ревизионных проходов. Счётчик (qualityRetryCount)
        // накапливается между QC-итерациями и не сбрасывается — QC-блок и
        // review-блок расходуют один и тот же бюджет проходов автора.
        const finalizationBlocked =
          qcBlocked || (fcReviewRequired && qualityRetryCount < MAX_FACTCHECK_REVIEW_PASSES);

        // Решение о финализации при живом reviewRequired — обязательно в лог
        // (наблюдаемость: почему статья ушла в публикацию с замечаниями фактчекера).
        if (fcReviewRequired && !qcBlocked && !finalizationBlocked) {
          console.warn(
            `[Worker] QC-gate: finalizationAllowed=true, но factchecker reviewRequired=true. ` +
            `Лимит ревизионных проходов автора (${MAX_FACTCHECK_REVIEW_PASSES}) исчерпан ` +
            `(qualityRetryCount=${qualityRetryCount}) → финализируем; reviewRequired больше не блокирует. ` +
            `Замечания фактчекера: ${Array.isArray(fcData.forbiddenClaimsRu) ? fcData.forbiddenClaimsRu.join('; ') : 'нет'}`
          );
        }

        if (finalizationBlocked) {
          const criticalIssues = Array.isArray(qcData.criticalIssuesRu)
            ? qcData.criticalIssuesRu
            : [];
          const forbiddenClaims = Array.isArray(fcData.forbiddenClaimsRu)
            ? fcData.forbiddenClaimsRu
            : [];
          const feedbackParts = [...criticalIssues, ...forbiddenClaims].filter(Boolean);
          const feedback = feedbackParts.join('; ') || 'Контроль качества не прошёл';

          if (qualityRetryCount >= MAX_QUALITY_RETRIES) {
            // Лимит попыток исчерпан. Программный guard: если есть какой-то
            // контент (author/factchecker/humanizer) — сохраняем лучший вариант
            // со статусом needs_review, а не failed. Это спасает статью: редактор
            // видит её в списке и может доработать вручную, вместо потери всей
            // генерации. Только если контента совсем нет → failed.
            console.error(
              `[Worker] Качество не прошло (попытка ${qualityRetryCount + 1}/${MAX_QUALITY_RETRIES + 1}). Лимит исчерпан.`
            );

            let savedNeedsReview = false;
            try {
              const bestContent = extractFinalArticle(structuredOutputs);
              if (bestContent?.content && bestContent.content.length > 500) {
                console.log(
                  `[Worker] Quality retries exhausted, но есть контент (${bestContent.content.length} chars) → сохраняем как needs_review`
                );
                await saveFinalVersion(article, articleId, structuredOutputs);
                // W2.2: постчек-отчёт уже создан внутри saveFinalVersion; enforce
                // здесь ничего не добавляет — статья и так уходит в needs_review.
                // U3: причина QC-исчерпания персистится в колонку (список очереди
                // и карточка читают её без выборки ранов).
                await prisma.article.update({
                  where: { id: articleId },
                  data: {
                    status: 'needs_review',
                    needsReviewReason: buildNeedsReviewReason(
                      `Качество не сошлось за ${MAX_QUALITY_RETRIES + 1} попыток. Замечания: ${feedback}`
                    ),
                  },
                });
                sendProgress(
                  buildProgressPayload({
                    articleId,
                    // Финальный кадр прогона: статья сохранена, нужен человек.
                    currentStage: TOTAL_STAGES,
                    stageName: 'Требуется проверка',
                    agentName: role.id,
                    description: 'Контент сохранён, требуется ручная проверка (needs_review)',
                    percent: 100,
                    status: 'completed',
                    message: `Качество не сошлось за ${MAX_QUALITY_RETRIES + 1} попыток, но контент сохранён для ручной проверки. Замечания: ${feedback}`,
                  })
                );
                savedNeedsReview = true;
                // НЕ throw unrecoverable — статья сохранена, job завершается штатно.
                logGenerationDigest(articleId, genTelemetry); // W4.5
                return;
              }
            } catch (saveErr) {
              console.error(
                `[Worker] saveFinalVersion(needs_review) упал: ${saveErr?.message || saveErr}. Падаем в failed.`
              );
            }

            if (!savedNeedsReview) {
              // Контента нет (или保存ение упало) → статья failed.
              const failReason = `Не удалось достичь приемлемого качества за ${MAX_QUALITY_RETRIES + 1} попытк(у/ок) и нет валидного контента для сохранения. Последние проблемы: ${feedback}`;
              await prisma.article.update({
                where: { id: articleId },
                data: { status: 'failed', needsReviewReason: null },
              });
              sendProgress(
                buildProgressPayload({
                  articleId,
                  currentStage: step,
                  stageName: role.nameRu,
                  agentName: role.id,
                  description: 'Качество не прошло: лимит попыток исчерпан',
                  percent: Math.round((step / TOTAL_STAGES) * 100),
                  status: 'error',
                  message: failReason,
                })
              );
              logGenerationDigest(articleId, genTelemetry); // W4.5
              throw unrecoverable(failReason);
            }
          }

          // Перезапуск с article-author (индекс 6). i=5 → i++ → 6.
          qualityRetryCount += 1;
          console.log(
            `[Worker] Качество не прошло (попытка ${qualityRetryCount}/${MAX_QUALITY_RETRIES + 1}). Перегенерация с feedback: ${feedback}`
          );

          // Инвалидируем выходы ролей после structure-architect.
          for (const resetRoleId of QUALITY_RESET_ROLES) {
            delete structuredOutputs[resetRoleId];
          }
          // Сбрасываем прокинутые черновики в context (Dev-A заполняет их заново).
          context.authorDraft = '';
          context.authorClaims = [];
          context.authorRiskyPhrases = [];
          context.factcheckedDraft = '';
          // Накопленный feedback: author видит ВСЕ прошлые замечания, а не только
          // последнюю попытку. Это устраняет цикл «исправил одно — сломал другое»:
          // модель должна избегать повторения КАЖДОЙ прошлой проблемы.
          context.qualityFeedback = context.qualityFeedback
            ? `${context.qualityFeedback}\n\n--- ПРЕДЫДУЩАЯ ПОПЫТКА ${qualityRetryCount} ---\n${feedback}`
            : feedback;

          // Откатываем цикл к article-author. structure-architect (i=5) уже готов,
          // его выход остаётся в structuredOutputs (не в QUALITY_RESET_ROLES).
          i = 5; // for-инкремент сделает i=6 → article-author
          continue;
        }

        // Вердикт положительный — снимаем feedback (на случай повторного прохода).
        if (context.qualityFeedback) {
          context.qualityFeedback = '';
        }
      }
    }

    /* 4. Сохранение финальной версии и завершение */
    // W2.2: saveFinalVersion возвращает { postcheckVerdict } — enforce-решение
    // о статусе принимает finalizeCompleted (report-режим: вердикт только в отчёте).
    const finalizeInfo = await saveFinalVersion(article, articleId, structuredOutputs);
    await finalizeCompleted(articleId, job, finalizeInfo);
    logGenerationDigest(articleId, genTelemetry); // W4.5
    return; // W-retry: прогон дошёл до конца — не проваливаться в следующую попытку
  }
}

async function saveFinalVersion(
  article,
  articleId,
  structuredOutputs,
  { skipFaq: skipFaqRequested = false, finalizedVia = 'normal' } = {},
) {
  // 2026-11-14: маркер шаблонного черновика автора (_fallbackTemplate,
  // ставится при transient-сбое роли автора — см. FIX-M2, 2026-08-17, выше)
  // означает, что LLM-провайдер на этой роли уже деградировал. FAQ-вызов по
  // такому черновику — это ~9 мин ожидания до fail-safe faq-генератора.
  // Аварийный путь finalizeWithFallback маркер учитывал (W1.3: skipFaq в
  // :3234-3235), а обычная финализация — нет: поведение было непоследовательным
  // (один и тот же флаг в одном пути работал, в другом игнорировался).
  // Здесь маркер учитывается ВСЕМИ путями финализации (обычный, needs_review,
  // wall-clock) — skipFaq перестал быть «одноразовым» флагом одного пути.
  // Живой авторский текст (без маркера) FAQ генерирует как раньше.
  const authorDraft = structuredOutputs?.['article-author'];
  const skipFaq = skipFaqRequested || authorDraft?._fallbackTemplate === true;

  const { title, description, h1, content } = extractFinalArticle(structuredOutputs);

  if (!content) {
    await prisma.article.update({
      where: { id: articleId },
      data: { status: 'failed', needsReviewReason: null },
    });
    throw unrecoverable('Финальный контент статьи не сформирован ни одной из ролей');
  }

  // T3+T2 (fix/article-quality-2026-08-14) + P4/P2 (2026-08-16): финальная
  // сборка текста ЕДИНООБРАЗНО:
  //   extract → mergeEmptySections (G1c) → sanitize (артефакты LLM + тех. секции)
  //   → normalize headings → internal links → FAQ «10 необычных вопросов»
  //   (сам прогоняет sanitize+normalize) → подпись автора → render HTML → persist
  //   { contentHtml, contentMarkdown, contentText } — все три поля строятся
  //   из ОДНОГО финального markdown.
  // G1(c) quality-calibration (2026-08-21): ДО sanitize/normalize сливаем
  // скелетные H2-секции (<100 симв. тела) в предыдущие — прод-данные 6/6
  // статей фейлили BODY-NO-EMPTY-SECTIONS. mergedHeadings исключаются из
  // HEAD-SECTION-COVERAGE (G1d) — слитый заголовок не «потерян», он осознанно
  // объединён. Сбой слияния не роняет сборку (fail-safe, как у sanitize).
  let finalContent = content;
  let mergedHeadings = [];
  try {
    const merged = mergeEmptySections(finalContent);
    if (merged.count > 0 || merged.firstSectionLeftAsIs > 0) {
      console.warn(
        `[Worker] G1(c) mergeEmptySections: articleId=${articleId}, слито скелетных секций — ` +
          `${merged.count} (${merged.mergedHeadings.join('; ') || '—'}); ` +
          `пустых первых секций оставлено — ${merged.firstSectionLeftAsIs}. mergedEmptySections=${merged.count}`
      );
      finalContent = merged.markdown;
      mergedHeadings = merged.mergedHeadings;
    }
  } catch (mergeErr) {
    console.error(
      `[Worker] mergeEmptySections упал для article ${articleId} (продолжаем без слияния):`,
      mergeErr?.message || mergeErr
    );
  }
  // Санитайзер вычищает CJK-вставки (qwen/deepseek), leaked-фенсы ```markdown,
  // ИИ-фразы, задвоенности и тех. секции («Источники», «Дополнительная
  // экспертная информация»); нормализатор чинит уровни заголовков. Отчёты
  // логируются (прозрачность вместо тихой правки). Оба шага — чистые
  // детерминированные функции; при неожиданном сбое публикация не падает,
  // используется текст после слияния пустых секций (G1c).
  const contentAfterMerge = finalContent;
  try {
    const sanitized = sanitizeArticle(finalContent);
    if (sanitized.report.wasModified) {
      console.warn(`[article-sanitizer] articleId=${articleId}`, JSON.stringify(sanitized.report));
    }
    finalContent = sanitized.markdown;

    const normalized = normalizeHeadings(finalContent);
    if (normalized.report.wasModified) {
      console.warn(`[heading-normalizer] articleId=${articleId}`, JSON.stringify(normalized.report));
    }
    finalContent = normalized.markdown;
  } catch (transformErr) {
    console.error(
      `[Worker] Финальная санитизация/нормализация упала для article ${articleId} (продолжаем без неё):`,
      transformErr?.message || transformErr
    );
    finalContent = contentAfterMerge;
  }

  // FIX-H1 (2026-08-25): H1-гарантия главного запроса. Правило
  // SEO-HEADINGS-MAIN требует вхождения главного запроса в H1; автор иногда
  // отдаёт H1 без него. ДЕТЕРМИНИРОВАННО: ключ морфологически НЕ входит в
  // ведущий H1 → H1 := «{MainQuery с заглавной}: {старый H1 со строчной,
  // ≤80 симв}» (ensureH1WithMainQuery). ОТДЕЛЬНЫЙ вызов ПОСЛЕ sanitize/
  // normalize, ДО трима/линкера/FAQ. Источник mainQuery —
  // тот же, что у semanticCore в постчек-контексте (runPostcheckAndPersist).
  // Fail-safe: сбой фикса не роняет сборку — контент без изменений.
  try {
    const mainQuery = buildSemanticCoreContext(structuredOutputs['semantic-strategist'])?.mainQueryRu;
    const h1Fixed = ensureH1WithMainQuery(finalContent, mainQuery);
    if (h1Fixed.fixed) {
      console.log('[h1-fix] applied', JSON.stringify({ articleId, mainQuery }));
      finalContent = h1Fixed.text;
    }
  } catch (h1Err) {
    console.error('[h1-fix] failed', h1Err?.message || h1Err);
  }

  // F2(b)+FIX-D3 quality-final (2026-08-21): детерминированный трим
  // переполненного тела — ПОСЛЕ сборки/слияния/sanitize/normalize, ДО
  // линкера/FAQ/подписи. База трима = (targetLength − CHUNK_TAIL_RESERVE_CHARS):
  // BODY-LENGTH-RANGE мерит финал С хвостом (FAQ+подпись), трим обязан
  // оставить под него бюджет. G2-стоп — вероятностная мера; если модель
  // проигнорировала лимит финального фрагмента и тело >1.30× базы, срезаем
  // ЦЕЛЫЕ завершающие абзацы последней контентной секции (пол 1.05× базы;
  // заголовки, таблицы, списки, FAQ/подпись неприкосновенны — см.
  // trimOverlongArticleBody). Сбой трима не роняет сборку (fail-safe).
  try {
    const trimTarget = Number(article?.targetLength) || 0;
    const trimmed = trimOverlongArticleBody(finalContent, { targetLength: trimTarget });
    if (trimmed.trimmed) {
      console.warn(
        `[Worker] trimmedWrapParagraphs: articleId=${articleId}, тело ${trimmed.charsBefore} → ` +
          `${trimmed.charsAfter} симв. (targetLength=${trimTarget}, база с резервом хвоста ` +
          `${trimTarget - CHUNK_TAIL_RESERVE_CHARS}), срезано завершающих абзацев — ` +
          `${trimmed.trimmedParagraphs}`
      );
      finalContent = trimmed.markdown;
    }
  } catch (trimErr) {
    console.error(
      `[Worker] Трим переполненного тела упал для article ${articleId} (продолжаем без трима):`,
      trimErr?.message || trimErr
    );
  }

  // Internal linking (Вариант A): программная инъекция markdown-ссылок на страницы
  // услуг/специалистов компании поверх финального текста. URL берётся из БД
  // (без галлюцинаций), анкор = каноническое имя. Срабатывает после humanizer/
  // factchecker → ссылки не будут переписаны. Координация с Программистом B:
  // каталог грузим здесь отдельным findMany (Prisma кэширует в пределах запроса,
  // дубликат запроса не страшен). Если Programmer B уже положил catalog в context —
  // этот шаг всё равно детерминирован и независим.
  // seo-round A4 (контракт Dev-B, internal-linker W3): прокидываем sourceSite
  // (baseUrl + имя компании) и карточку привязанной услуги (канон-URL/имя) —
  // канон/сайт→главная логика живёт ВНУДИ линкера, воркер только поставщик
  // данных; maxLinks — объёмно-зависимая капа из seo-standards (8/10).
  let linkedContent = finalContent;
  let linkerCanonicalServiceUrl = '';
  // B2 (2026-08-25): данные каталога специалистов для постчек-правила
  // LINKS-SPECIALIST-PRESENT (воркер — единственный поставщик; сам постчек
  // детерминирован и БД не читает). Специалисты грузятся блоком линкера ниже.
  let linkerSpecialistsCount = 0;
  let linkerSpecialistPageUrls = [];
  try {
    // M2: crawl-каталога больше нет — линкер получает пустой
    // каталог (0 инъекций, детерминированный проход цепочки мутаторов) и имя
    // компании из CompanyProfile (канон/сайт→главная логика внутри линкера).
    const linkerProfile = await loadCompanyProfile();
    const catalog = { services: [], specialists: [] };
    const { markdown: linked, injected, canonicalServiceUrl } = injectInternalLinks(finalContent, catalog, {
      maxLinks: linksByLength(article?.targetLength).max,
      returnAudit: true,
      canonicalServiceUrl: '',
      canonicalServiceName: '',
      sourceSiteBaseUrl: '',
      siteName: typeof linkerProfile?.name === 'string' ? linkerProfile.name : '',
      // P1d: utm_campaign = id статьи (включается env GENERAPTOR_UTM_ENABLED).
      utmCampaign: String(articleId),
    });
    linkedContent = linked;
    // ОЖИДАЕМЫЙ канон-URL (даже если ссылка не поставлена) — в постчек
    // (правило CANONICAL-LINK-ZONE честно warn/skip, а не слепой pass).
    if (typeof canonicalServiceUrl === 'string') {
      linkerCanonicalServiceUrl = canonicalServiceUrl;
    }
    if (injected?.length) {
      console.log(
        `[Worker] Internal linking: injected ${injected.length} links into article ${articleId}`
      );
    }
  } catch (linkErr) {
    // Internal linking — необязательная SEO-фича, не должна ронять публикацию.
    console.error(
      `[Worker] Internal linking упал для article ${articleId} (продолжаем без ссылок):`,
      linkErr?.message || linkErr
    );
    linkedContent = finalContent;
  }

  // P4 (2026-08-16): FAQ «10 необычных вопросов». Вставка ПОСЛЕ линкера
  // (линкер не сканирует/не спамит анкоры внутри FAQ) и ДО подписи автора.
  // Блок ОБЯЗАТЕЛЬНО проходит свой sanitize+normalize (QA-блокер: иначе
  // CJK/артефакты LLM-ответа уходят во все 3 поля финальной версии без
  // очистки). Идемпотентность-гард: если итоговый markdown уже содержит
  // секцию необычных вопросов (повторный прогон сохраняет articleVersion, но
  // saveFinalVersion может быть вызван повторно) — НЕ вставляем второй.
  // Fail-safe: любая ошибка генерации → WARN и статья сохраняется БЕЗ FAQ.
  let faqBlock = '';
  try {
    if (skipFaq) {
      // W1.3 (2026-08-17) + 2026-11-14:
      // skipFaq означает, что итоговый текст — ШАБЛОН, а не живой автор:
      // либо авторского вывода нет вовсе (LLM недоступна с первых ролей —
      // аварийный путь finalizeWithFallback), либо автор отработал шаблонным
      // fallback'ом с маркером _fallbackTemplate (transient-сбой роли автора).
      // FAQ-вызов по мёртвому провайдеру лишь добавил бы попытки ожидания
      // (~9 мин до fail-safe). При живом авторском тексте FAQ идёт обычной
      // веткой ниже — у faq-генератора свой fail-safe.
      console.log(`[faq-generator] articleId=${articleId}: пропуск FAQ (черновик-шаблон: живого авторского вывода нет)`);
    } else if (!hasUnusualFaqSection(linkedContent)) {
      // seo-round A4/B2 + M2: faqContext.keywords — топ-12 ключей SEO-ядра
      // (mainQueryRu + кластеры + LSI от semantic-strategist). Контракт
      // generateUnusualFaqMarkdown({... existing, keywords}) — параметр
      // optional, B рендерит его в user-сообщение FAQ-вызова.
      const faqCore = buildSemanticCoreContext(structuredOutputs['semantic-strategist']);
      const faqKeywords = [
        faqCore?.mainQueryRu || '',
        ...(Array.isArray(faqCore?.queryClustersRu) ? faqCore.queryClustersRu : []).flatMap((c) => {
          if (typeof c === 'string') return [c];
          if (c && typeof c === 'object') return [c.clusterRu || '', ...(Array.isArray(c.queriesRu) ? c.queriesRu : [])];
          return [];
        }),
        ...(Array.isArray(faqCore?.lsiTermsRu) ? faqCore.lsiTermsRu : []),
      ]
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter(Boolean)
        .slice(0, 12);
      const faqContext = {
        topic: article?.topic || h1 || title || '',
        h1,
        headings: extractFaqHeadings(linkedContent),
        conclusionExcerpt: extractConclusionExcerpt(linkedContent),
        keywords: faqKeywords,
      };
      const generated = await generateUnusualFaqMarkdown(faqContext);
      if (generated) {
        // QA-блокер: CJK/артефакты LLM-ответа не должны уходить в финальные
        // поля — блок проходит собственный sanitize ДО вставки.
        const faqSanitized = sanitizeArticle(generated);
        if (faqSanitized.report.wasModified) {
          console.warn(
            `[faq-generator] articleId=${articleId}: FAQ-блок очищен`,
            JSON.stringify(faqSanitized.report.counts)
          );
        }
        faqBlock = faqSanitized.markdown;
      }
    } else {
      console.log(`[faq-generator] articleId=${articleId}: FAQ-секция уже присутствует, пропуск вставки`);
    }
  } catch (faqErr) {
    console.warn(`[faq-generator] articleId=${articleId}: генерация FAQ упала, статья сохраняется без FAQ:`, faqErr?.message || faqErr);
    faqBlock = '';
  }

  // P2 (2026-08-16): подпись автора. ПОСЛЕ FAQ и ПОСЛЕ линкера (ФИО не должен
  // стать инлайн-ссылкой). Строится ТОЛЬКО из fullName+position специалиста;
  // legacy specialist.authorSignature ИГНОРИРУЕТСЯ (QA-блокер: у seed-данных
  // он равен голому ФИО без должности). specialistId null → БЕЗ подписи.
  let signatureBlock = '';
  try {
    signatureBlock = await buildAuthorSignature(article, articleId);
  } catch (sigErr) {
    console.warn(`[Worker] articleId=${articleId}: подпись автора не построена (статья сохраняется без неё):`, sigErr?.message || sigErr);
    signatureBlock = '';
  }

  // Итоговый хвост: [основной контент] → FAQ → подпись. Все 3 поля
  // (contentHtml/contentMarkdown/contentText) строятся из ЭТОГО markdown.
  let finalMarkdown = linkedContent.replace(/\n+$/, '');
  if (faqBlock) {
    finalMarkdown += `\n\n${faqBlock}`;
    // Нормализация уровней FAQ-заголовков — В КОНТЕКСТЕ документа, не блока:
    // normalizeHeadings продвигает первый заголовок одиночного фрагмента в
    // H1, а хвост статьи обязан остаться на уровне H2/H3. Статьянная часть
    // уже нормализована (шаг выше) и идемпотентна — повторный прогон no-op,
    // чинятся только уровни FAQ.
    const faqNormalized = normalizeHeadings(finalMarkdown);
    if (faqNormalized.report.wasModified) {
      console.warn(
        `[faq-generator] articleId=${articleId}: уровни заголовков FAQ нормализованы`,
        JSON.stringify(faqNormalized.report.counts)
      );
    }
    finalMarkdown = faqNormalized.markdown.replace(/\n+$/, '');
  }

  // seo-deterministic round (2026-08-27):
  // детерминированные SEO-пост-правила в окне между FAQ-хвостом и подписью,
  // строго в порядке b → c → a — редукция плотности идёт ПОСЛЕ вставок и не
  // съедает их (вставленные блок/CTA распознаются по заголовку блока и
  // CTA-префиксам внутри reduceKeySpam как untouchable). Каждый шаг — свой
  // try/catch fail-safe (паттерн [h1-fix]): сбой правила не роняет сборку.
  try {
    // b) injectExpertsBlock — блок «Консультация специалистов» только в
    //    режиме «без выбранного специалиста» (закрывает LINKS-SPECIALIST-
    //    PRESENT; если автор сам упомянул ≥2 экспертов каталога — no-op).
    // M2: выбранного специалиста не бывает (FK убраны) — блок всегда в режиме
    // «без каталога»: injectExpertsBlock сам честно no-op'ает с причиной.
    {
      const expertsProfile = await loadCompanyProfile();
      const experts = injectExpertsBlock(finalMarkdown, [], typeof expertsProfile?.name === 'string' ? expertsProfile.name : '', articleId);
      if (experts.inserted) {
        finalMarkdown = experts.markdown;
        console.log(
          `[experts-block] articleId=${articleId}: вставлен блок «${experts.heading}» (${experts.specialistsUsed.length} специалиста с pageUrl)`
        );
      } else {
        console.log(`[experts-block] articleId=${articleId}: пропуск (${experts.reason})`);
      }
    }
  } catch (expertsErr) {
    console.error(
      `[experts-block] articleId=${articleId}: блок специалистов не вставлен (продолжаем без него):`,
      expertsErr?.message || expertsErr
    );
  }

  try {
    // c) ensureSiteMentions — ≤2 CTA-упоминаний компании (ротация articleId,
    //    имя не склоняется). min — по нормативу mentionsByLength от текущего
    //    объёма (паритет MENTIONS-SITE-COUNT постчека).
    // M2: имя компании — CompanyProfile (crawl-источник убран).
    const mentionsProfile = await loadCompanyProfile();
    const siteNameForMentions = typeof mentionsProfile?.name === 'string' ? mentionsProfile.name.trim() : '';
    if (siteNameForMentions) {
      // Приближение плейн-текста (длина с сохранением позиций): анкоры
      // разворачиваются, фенсы выбрасываются, разметка → пробелы.
      const approxPlainChars = finalMarkdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#>*`|_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;
      const mentionsMin = mentionsByLength(approxPlainChars).min;
      const mentions = ensureSiteMentions(finalMarkdown, siteNameForMentions, mentionsMin, articleId);
      if (mentions.added > 0) {
        finalMarkdown = mentions.markdown;
        console.log(
          `[site-mentions] articleId=${articleId}: +${mentions.added} CTA (${mentions.mentionsBefore}→${mentions.mentionsAfter}, min=${mentionsMin})`
        );
      }
    }
  } catch (mentionsErr) {
    console.error(
      `[site-mentions] articleId=${articleId}: CTA-упоминания не добавлены (продолжаем без них):`,
      mentionsErr?.message || mentionsErr
    );
  }

  try {
    // a) reduceKeySpam — авторедукция плотности ядра (замены только
    //    вне ядра, разбавленные вхождения не трогаем — cap-not-reached честно
    //    логируется). seoCore — паритет постчек-контекста
    //    (runPostcheckAndPersist); M2: ключи только из semanticCore.
    const seoCore = buildSemanticCoreContext(
      structuredOutputs['semantic-strategist'],
      article?.targetLength,
    );
    const spam = reduceKeySpam(finalMarkdown, seoCore);
    finalMarkdown = spam.text;
    const s = spam.stats || {};
    const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—');
    console.log(
      `[seo-spam-reduce] articleId=${articleId}: density ${pct(s.densityBefore)}→${pct(s.densityAfter)}, правок perKey=${spam.reduced.perKey} total=${spam.reduced.total} headings=${spam.reduced.headings}${s.reason ? ` (${s.reason})` : ''}`
    );
    if (Array.isArray(s.capNotReached) && s.capNotReached.length > 0) {
      console.warn(
        `[seo-spam-reduce] articleId=${articleId}: cap-not-reached (честный отказ — разбавленные/untouchable вхождения)`,
        JSON.stringify(s.capNotReached)
      );
    }
  } catch (spamErr) {
    console.error(
      `[seo-spam-reduce] articleId=${articleId}: редукция упала (статья сохраняется без неё):`,
      spamErr?.message || spamErr
    );
  }

  // ── P2-2: детерминированный блок записи «Как ─────────
  // записаться…» — СЛОТ замороженного порядка мутаторов: ПОСЛЕ
  // ensureSiteMentions, ДО второго mergeEmptySections. Pure
  // insertion — существующие шаги не переставлены. Внутри окна слота вызов
  // стоит строго перед merge#2 (а не сразу за mentions): reduceKeySpam не
  // должен видеть токены блока (иначе детерминированный текст разводняется,
  // а плотность/кап автора меняется — инвариант 6 «byte-identical»).
  // Хелпер идемпотентен и crash-safe; try/catch-пояс — паттерн линкера.
  try {
    // M2: имя компании — CompanyProfile (crawl-источник убран).
    const formRecProfile = await loadCompanyProfile();
    const siteNameForFormRec =
      typeof formRecProfile?.name === 'string' ? formRecProfile.name.trim() : '';
    const formRec = injectFormRecommendationBlock(finalMarkdown, siteNameForFormRec, articleId);
    if (formRec.inserted) {
      finalMarkdown = formRec.markdown;
      console.log(
        `[form-rec-block] articleId=${articleId}: вставлен блок «${formRec.heading}» (${formRec.reason})`
      );
    } else {
      console.log(`[form-rec-block] articleId=${articleId}: пропуск (${formRec.reason})`);
    }
  } catch (formRecErr) {
    console.error(
      `[form-rec-block] articleId=${articleId}: блок записи не вставлен (продолжаем без него):`,
      formRecErr?.message || formRecErr
    );
  }

  // G1(c)-pass2: контент-мутаторы ПОСЛЕ первого слияния (трим перелива режет
  // абзацы с конца, линкер/FAQ/детерминаторы меняют тело) могут оставить от
  // секции огрызок <100 симв — BODY-NO-EMPTY-SECTIONS ловит его на финале.
  // Повторный проход mergeEmptySections (идемпотентен) закрывает все причины
  // опустошения; mergedHeadings копятся для HEAD-SECTION-COVERAGE.
  try {
    const merged2 = mergeEmptySections(finalMarkdown);
    if (merged2.count > 0) {
      console.warn(
        `[merge-empty-pass2] articleId=${articleId}: слито секций, опустевших после трима/детерминаторов — ` +
          `${merged2.count} (${merged2.mergedHeadings.join('; ') || '—'})`
      );
      finalMarkdown = merged2.markdown;
      mergedHeadings = [...mergedHeadings, ...merged2.mergedHeadings];
    }
  } catch (merge2Err) {
    console.error(
      `[merge-empty-pass2] articleId=${articleId}: повторное слияние упало (продолжаем без него):`,
      merge2Err?.message || merge2Err
    );
  }

  // P1b (2026-09-18): deterministic «Обновлено:
  // DD.MM.YYYY» line — house pattern of the author signature: inserted at
  // the SAME late stage (every reduce/trim/merge mutator has already run →
  // the same untouchable guarantees), immediately BEFORE the signature block
  // so the frozen SIG-PRESENT contract (signature = last non-empty line)
  // keeps passing. Idempotent: the helper strips any previous occurrence
  // (model-emitted or re-save) before inserting. Date source: timestamp of
  // the version being saved (≈ the ArticleVersion.createdAt/updatedAt row
  // persisted below; one clock read per save, reused by JSON-LD dateModified).
  // Fail-safe: a helper crash never breaks the save.
  const versionTimestamp = new Date();
  try {
    finalMarkdown = appendUpdatedDateLine(finalMarkdown, versionTimestamp);
  } catch (dateLineErr) {
    console.warn(
      `[updated-line] articleId=${articleId}: строка «Обновлено» не добавлена (продолжаем без неё):`,
      dateLineErr?.message || dateLineErr
    );
  }

  if (signatureBlock) {
    finalMarkdown += signatureBlock;
  }

  // B1: финальный текст (с внедрёнными markdown-ссылками) → санитизированный HTML.
  // Это единственное место, где markdown статьи превращается в HTML: content_html
  // теперь хранит готовый HTML, который фронт рендерит через dangerouslySetInnerHTML.
  // Серверная санитизация (DOMPurify + jsdom) обязательна — LLM может вернуть <script>.
  const contentHtml = renderMarkdownToHtml(finalMarkdown);
  const contentText = htmlToPlainText(contentHtml);
  const characterCount = contentText.length;

  // W2.2 (2026-08-17): постпродакшен-проверка — ПОСЛЕ рендера, ДО persist.
  // Чистая детерминированная функция (27 правил) над финальным markdown/html;
  // отчёт — в служебный AgentRun «Пост-проверка качества» (паттерн служебных
  // ранов вне 11 ролей, без миграций). Fail-safe: любой сбой самой проверки
  // НЕ роняет сохранение статьи — статья выходит как до W2.
  // U3: возвращает и список fail-правил (для needsReviewReason при enforce).
  const postcheck = await runPostcheckAndPersist(article, articleId, structuredOutputs, {
    markdown: finalMarkdown,
    html: contentHtml,
    finalizedVia,
    // G1(d): нормализованные заголовки секций, слитых mergeEmptySections, —
    // HEAD-SECTION-COVERAGE исключает их из ожидаемого покрытия.
    mergedHeadings,
    // seo-round A5: ожидаемый канон-URL из линкера (Dev-B контракт) — правило
    // CANONICAL-LINK-ZONE валидатора честно warn/skip, а не слепой pass.
    canonicalServiceUrl: linkerCanonicalServiceUrl,
    // B2: каталог специалистов (число + pageUrl) для LINKS-SPECIALIST-PRESENT.
    sourceSpecialistsCount: linkerSpecialistsCount,
    specialistPageUrls: linkerSpecialistPageUrls,
  });
  const postcheckVerdict = postcheck?.verdict ?? null;
  const postcheckFailures = Array.isArray(postcheck?.failures) ? postcheck.failures : [];

  // P1c (2026-09-18): JSON-LD structured data
  // (schema.org @graph: Article + FAQPage) attached to the stored contentHtml
  // STRICTLY AFTER the postcheck input assembly above (the check must stay
  // blind to machine data — JSON text would corrupt density/phrase/link
  // counts) and after contentText/characterCount (derived fields never see
  // the script; htmlToPlainText is script-blind since P1c, so consumers
  // re-deriving text from stored contentHtml stay clean too). Q/A source:
  // the rendered FAQ section of THIS markdown (single source of truth).
  // Author: specialist card (specialist mode), affiliation = company name.
  // Idempotent (stale schema script is replaced); fail-safe on any error.
  let persistedHtml = contentHtml;
  try {
    // M2: имя компании — CompanyProfile; публикационных колонок больше нет.
    const schemaProfile = await loadCompanyProfile();
    const jsonLdScript = buildArticleJsonLd({
      articleId,
      headline: title || h1 || article.topic,
      datePublished: article?.createdAt || versionTimestamp,
      dateModified: versionTimestamp,
      specialist: null,
      siteName: typeof schemaProfile?.name === 'string' ? schemaProfile.name : '',
      faq: extractFaqEntries(finalMarkdown),
    });
    persistedHtml = attachArticleJsonLd(contentHtml, jsonLdScript);
  } catch (jsonLdErr) {
    console.warn(
      `[jsonld] articleId=${articleId}: JSON-LD не приложен (статья сохраняется без разметки):`,
      jsonLdErr?.message || jsonLdErr
    );
    persistedHtml = contentHtml;
  }

  const latestVersion = article.versions[0]?.version || 0;
  await prisma.articleVersion.create({
    data: {
      articleId,
      version: latestVersion + 1,
      platform: 'base',
      title: title || h1 || article.topic,
      description: description || null,
      contentHtml: persistedHtml,
      // T6: финальный markdown (тот самый, из которого отрендерены contentHtml
      // и contentText) — для последующих трансформаций без обратного парсинга HTML.
      contentMarkdown: finalMarkdown,
      contentText,
      characterCount,
    },
  });

  // U3: failures — аддитивно, для buildNeedsReviewReason в finalizeCompleted.
  return { postcheckVerdict, postcheckFailures };
}

/**
 * W2.2: собирает контекст постпроверки (данные уже в области видимости
 * saveFinalVersion + один узкий запрос таймингов по ранам статьи), запускает
 * runArticlePostcheck и персистит отчёт служебным AgentRun-ом.
 *
 * hasSuccessfulFactcheckRun — честный источник: structuredOutputs['factchecker']
 * существует ТОЛЬКО если фактчекер вернул валидный checkedArticleMarkdownRu над
 * текстом, из которого собрана финальная версия (extractFinalArticle: humanizer →
 * factchecker → author). QC-сброс (QUALITY_RESET_ROLES) удаляет ключ — после
 * сбоя фактчекера в retry-цикле финал собирается из нефактчекенного авторского
 * черновика, и ключ честно отсутствует → FACTCHECK-COVERAGE провален.
 *
 * @returns {Promise<'ok'|'warn'|'fail'|null>} verdict или null при сбое (fail-safe).
 */
async function runPostcheckAndPersist(
  article,
  articleId,
  structuredOutputs,
  {
    markdown,
    html,
    finalizedVia = 'normal',
    mergedHeadings = [],
    canonicalServiceUrl = '',
    // B2: каталог специалистов для LINKS-SPECIALIST-PRESENT (поставщик —
    // линкерный блок saveFinalVersion; см. правило в article-postcheck.mjs).
    sourceSpecialistsCount = null,
    specialistPageUrls = null,
  } = {}
) {
  const startedAt = new Date();
  try {
    let timings = {};
    try {
      timings = await loadRoleTimingsMs(articleId);
    } catch (timingErr) {
      // Тайминги — телеметрия для minor-правила TIMING-ANOMALY, не блокируют отчёт.
      console.warn(
        `[postcheck] articleId=${articleId}: тайминги ролей не загружены (${timingErr?.message || timingErr})`
      );
    }

    // M2: источник убран — имя компании берём из CompanyProfile (одна строка);
    // baseUrl пуст (домена сайта нет → link-правила честно skip).
    const companyProfile = await loadCompanyProfile();
    const structureData = structuredOutputs['structure-architect'];

    const context = {
      topic: article?.topic || '',
      targetLength: article?.targetLength ?? null,
      specialistId: article?.specialistId ?? null,
      hasSuccessfulFactcheckRun: Boolean(structuredOutputs['factchecker']?.checkedArticleMarkdownRu),
      // W2: 'normal' | 'fallback' — метрика PROCESS-FINALIZATION.
      finalizedVia,
      structuredOutputs,
      semanticCore: buildSemanticCoreContext(structuredOutputs['semantic-strategist'], article?.targetLength),
      formatRuSections: Array.isArray(structureData?.sectionsRu) ? structureData.sectionsRu : [],
      timings,
      // G1(d): заголовки, слитые постпроцессором (нормализованные), —
      // валидатор исключает их из HEAD-SECTION-COVERAGE.
      mergedHeadings: Array.isArray(mergedHeadings) ? mergedHeadings : [],
      // Опциональное дополнение контракта: домен сайта для link-правил
      // (нейтральный ключ siteDomains).
      siteDomains: [],
      // seo-round A5: источник для MENTIONS/LINKS-правил по объёму (имя бренда
      // сайта). M2: CompanyProfile вместо crawl-источника, baseUrl нет.
      sourceSite: companyProfile?.name
        ? { name: companyProfile.name, baseUrl: '' }
        : null,
      canonicalServiceUrl: typeof canonicalServiceUrl === 'string' ? canonicalServiceUrl.trim() : '',
      // B2: каталог специалистов источника — для LINKS-SPECIALIST-PRESENT.
      // sourceSpecialistsCount=null → постчек честно skip'ает правило
      // (легаси-вызовы без данных); массив pageUrl может быть пустым
      // (ни у одного специалиста нет страницы — тогда правило уходит в эвристику).
      sourceSpecialistsCount:
        Number.isFinite(Number(sourceSpecialistsCount)) && sourceSpecialistsCount !== null
          ? Number(sourceSpecialistsCount)
          : null,
      specialistPageUrls: Array.isArray(specialistPageUrls)
        ? specialistPageUrls.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
        : null,
    };

    // mode передаётся для симметрии API: внутри валидатора он НИЧЕГО не меняет
    // (все правила считаются всегда) — enforce-логика в finalizeCompleted.
    const report = runArticlePostcheck({ markdown, html, context }, { mode: resolvePostcheckMode() });

    // Option A (2026-09-17): grounding score — REPORT-ONLY additive summary
    // key (NOT a postcheck rule; the 39-rule pinned set — POSTCHECK_RULE_IDS,
    // server/lib/article-postcheck.mjs — and the frozen report shape are
    // untouched). Runs after render/postcheck input assembly and
    // never mutates the article text; computed by the pure deterministic
    // lib/grounding-score.mjs from the final markdown + crawled ResearchSource
    // rows. Fail-safe: any error keeps the report unchanged.
    await attachGroundingScore(report, articleId, markdown);

    await prisma.agentRun.create({
      data: {
        articleId,
        agentName: POSTCHECK_AGENT_NAME,
        status: 'completed',
        progress: 100,
        outputJson: JSON.stringify(report),
        startedAt,
        finishedAt: new Date(),
      },
    });

    const failures = report.rules.filter((r) => r.status === 'fail');
    console.warn(
      `[postcheck] articleId=${articleId}: verdict=${report.verdict} ` +
        `pass=${report.summary.pass} fail=${report.summary.fail} skipped=${report.summary.skipped}` +
        (failures.length
          ? ` | провалы: ${failures.map((r) => `${r.id}(${r.severity})`).join(', ')}`
          : '')
    );
    // U3: failures идут в finalizeCompleted для needsReviewReason (enforce-режим).
    return { verdict: report.verdict, failures };
  } catch (err) {
    console.warn(
      `[postcheck] articleId=${articleId}: сбой постпроверки (${err?.message || err}) — ` +
        `статья сохраняется без отчёта (fail-safe)`
    );
    return { verdict: null, failures: [] };
  }
}

/**
 * Option A (2026-09-17, 20260917-openresearch-integration): attach the
 * grounding score to the postcheck report as the ADDITIVE summary key
 * `grounding` (the Option A "groundingScore" composite from
 * the 2026-09-17 analysis round; lives in summary.grounding.score).
 *
 * Contract (report-only):
 *   - never mutates the article text;
 *   - never touches verdict / rules[] / summary.pass-fail-skipped;
 *   - never throws — any failure logs a warning and leaves the report
 *     unchanged (the score can never fail an article);
 *   - no new postcheck rule: the 39-rule pinned set is untouched, the key
 *     carries no severity/status.
 *
 * Worker is the sole data supplier (narrow ResearchSource query — the same
 * pattern as loadRoleTimingsMs); the computation itself is the pure
 * deterministic lib/grounding-score.mjs (no LLM, no network, no clock).
 * Called from runPostcheckAndPersist BEFORE the report is persisted into
 * AgentRun.outputJson, so the score lands in the stored audit trail.
 * Exported for the DB-free unit test (pattern: buildAuthorSignature /
 * tests/unit/author-signature.test.mjs).
 *
 * @param {object} report postcheck report returned by runArticlePostcheck.
 * @param {string} articleId
 * @param {string} articleMarkdown final article markdown (post-mutators, post-strip).
 * @returns {Promise<object>} the same report (with summary.grounding when computable).
 */
export async function attachGroundingScore(report, articleId, articleMarkdown) {
  if (!report || typeof report !== 'object' || !report.summary || typeof report.summary !== 'object') {
    return report;
  }
  try {
    const rows = await prisma.researchSource.findMany({
      where: { articleId },
      select: { provider: true, evidenceLevel: true, title: true, snippet: true, extractedText: true },
    });
    const grounding = computeGroundingScore({
      articleText: articleMarkdown,
      sources: sourcesFromResearchRows(rows),
    });
    report.summary.grounding = grounding;
    console.log(
      `[grounding-score] articleId=${articleId}: score=${grounding.score} ` +
        `coverage=${grounding.coverage ?? '—'} evidenceMix=${grounding.evidenceMix ?? '—'} ` +
        `sources=${grounding.details.sourceCount} consensus=${grounding.details.consensusSourceCount} (report-only)`
    );
  } catch (err) {
    console.warn(
      `[grounding-score] articleId=${articleId}: score not computed ` +
        `(${err?.message || err}) — report-only, report persisted without it`
    );
  }
  return report;
}

/**
 * W2.2: длительности ролей статьи по AgentRun-ам (startedAt→finishedAt,
 * max на роль — ретраи роли не суммируются, берём худший ран). Раны без
 * finishedAt (зависшие 'running' — находка аналитика) пропускаются.
 */
async function loadRoleTimingsMs(articleId) {
  const runs = await prisma.agentRun.findMany({
    where: { articleId },
    select: { agentName: true, startedAt: true, finishedAt: true },
  });
  const timings = {};
  for (const run of runs) {
    if (!run.startedAt || !run.finishedAt) continue;
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) continue;
    timings[run.agentName] = Math.max(timings[run.agentName] ?? 0, ms);
  }
  return timings;
}

/**
 * P2 (2026-08-16): подпись автора из карточки специалиста.
 *
 * ВСЕГДА строится из fullName + position. Legacy specialist.authorSignature
 * ИГНОРИРУЕТСЯ (QA-блокер: у seed-специалистов он равен голому ФИО, без
 * должности и без форматирования). article.specialistId null → '' (без
 * подписи, никакого «null» в тексте).
 *
 * B2 (2026-08-25): при specialist.pageUrl подпись — markdown-ссылка на
 * страницу специалиста: **Автор статьи:** [ФИО, должность](pageUrl)
 * (контракт №6 плана; ссылку строит КОД, не автор — инвариант И2/И1).
 *
 * Экспортирована для юнит-теста формата (tests/unit/author-signature.test.mjs).
 *
 * @param {object} article — статья с include specialist: true (worker грузит).
 * @param {string} articleId — для логов.
 * @returns {Promise<string>} '' | '\n\n---\n\n**Автор статьи:** ФИО, должность\n'
 *   | '\n\n---\n\n**Автор статьи:** [ФИО, должность](pageUrl)\n'
 */
export async function buildAuthorSignature(article, articleId) {
  const specialistId = article?.specialistId || null;
  if (!specialistId) return '';

  // Worker грузит article с include { specialist: true } — обычно специалист
  // уже в объекте. Fallback на точечный findUnique — защитный путь, если
  // saveFinalVersion вызовут с урезанным article (select
  // включает pageUrl, иначе защитный путь терял бы ссылку).
  let specialist = article?.specialist || null;
  if (!specialist) {
    specialist = await prisma.specialist.findUnique({
      where: { id: specialistId },
      select: { fullName: true, position: true, pageUrl: true },
    });
  }

  const fullName = typeof specialist?.fullName === 'string' ? specialist.fullName.trim() : '';
  if (!fullName) {
    console.warn(`[Worker] articleId=${articleId}: specialistId есть, но fullName пуст — подпись не добавлена`);
    return '';
  }
  const position = typeof specialist?.position === 'string' ? specialist.position.trim() : '';
  const namePart = `${fullName}${position ? `, ${position}` : ''}`;
  const pageUrl = typeof specialist?.pageUrl === 'string' ? specialist.pageUrl.trim() : '';

  if (pageUrl) {
    return `\n\n---\n\n**Автор статьи:** [${namePart}](${pageUrl})\n`;
  }
  return `\n\n---\n\n**Автор статьи:** ${namePart}\n`;
}

/**
 * P4: заголовки H2/H3 из финального markdown — компактный контекст для
 * FAQ-генератора. Заголовки внутри code-fence пропускаются.
 */
function extractFaqHeadings(markdown) {
  if (typeof markdown !== 'string' || !markdown) return [];
  const out = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{2,3})[ \t]+(.*?)[ \t]*$/.exec(line);
    if (m && m[2].trim()) {
      out.push(m[2].trim());
    }
  }
  return out.slice(0, 40); // компактность промпта
}

/**
 * P4: первые ~500 символов заключения — контекст для FAQ-генератора.
 * Ищет H2-секцию с заголовком «Заключение/Выводы/Итоги»; если такой нет —
 * берёт текст последней H2-секции (заключение почти всегда последнее).
 */
function extractConclusionExcerpt(markdown, maxChars = 500) {
  if (typeof markdown !== 'string' || !markdown) return '';
  const lines = markdown.split('\n');

  // Собираем H2-секции: [{ heading, bodyStart, bodyEnd }]
  const sections = [];
  let current = null;
  let inFence = false;
  for (const line of lines) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      continue;
    }
    const m = /^ {0,3}##[ \t]+(.*?)[ \t]*$/.exec(line);
    if (!inFence && m) {
      current = { heading: m[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  const conclusionRegex = /заключени|вывод|итог/i;
  const target = sections.find((s) => conclusionRegex.test(s.heading)) || sections[sections.length - 1];
  if (!target) return '';

  const text = target.lines
    .join(' ')
    .replace(/[#>*`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}

async function finalizeCompleted(articleId, job, { postcheckVerdict = null, postcheckFailures = [] } = {}) {
  // W2.2 (enforce): verdict='fail' → needs_review ВМЕСТО ready — во всех путях
  // финализации, кроме случая когда статья уже идёт в needs_review (QC-ветка
  // не вызывает finalizeCompleted). Механизм статуса — существующий
  // (article.update + WS-сообщение с причиной), как в QC-exhausted-ветке.
  const enforceNeedsReview =
    resolvePostcheckMode() === 'enforce' && postcheckVerdict === 'fail';

  // U3: причина персистится только при уходе в needs_review; ready — сброс
  // (статья прошла полный конвейер, «наследованная» причина неактуальна).
  let needsReviewReason = null;
  if (enforceNeedsReview) {
    const failIds = postcheckFailures.map((f) => f.id).filter(Boolean);
    const shown = failIds.slice(0, 5).join(', ') + (failIds.length > 5 ? ` +${failIds.length - 5}` : '');
    needsReviewReason = buildNeedsReviewReason(
      `Качество: ${postcheckFailures.length} проваленных правил (${shown})`
    );
  }

  // M2: автогенерация убрана — moderation gate и run-ledger
  // удалены; needs_review теперь ставит только postcheck-enforce.
  const needsReview = enforceNeedsReview;

  await prisma.article.update({
    where: { id: articleId },
    data: { status: needsReview ? 'needs_review' : 'ready', needsReviewReason },
  });

  if (enforceNeedsReview) {
    console.warn(
      `[postcheck] articleId=${articleId}: enforce — verdict=fail, статья переведена в needs_review вместо ready (причина — в ране «${POSTCHECK_AGENT_NAME}»)`
    );
  }

  await job.updateProgress(100);

  sendProgress(
    buildProgressPayload({
      articleId,
      currentStage: TOTAL_STAGES,
      stageName: needsReview ? 'Требуется проверка' : 'Готово',
      agentName: 'humanizer',
      description: needsReview
        ? 'Статья сохранена, постпроверка нашла критичные проблемы'
        : 'Статья готова',
      percent: 100,
      status: 'completed',
      message: needsReview
        ? 'Статья сохранена, но постпроверка качества нашла критичные проблемы — требуется ручная проверка (needs_review). Подробности — в прогоне «Пост-проверка качества».'
        : 'Генерация статьи завершена успешно',
    })
  );

  console.log(`[Worker] Article generation completed: articleId=${articleId}`);

  // Cover checkbox wave (Director resolution Q3): the cover phase launches
  // AFTER the terminal status — the progress stream is already closed and the
  // article is ready/published for the owner. Fire-and-forget: NOT awaited, so
  // the worker slot is freed immediately (1–5 min of image work must not hold
  // the pipeline); progress/state travels on the per-article coverStatus
  // channel (UI polls GET /:id/content). The hook swallows flow errors into
  // coverStatus/coverSkipReason; this .catch is only for a crash OF the hook.
  // finalizeWithFallback reaches this same call through finalizeCompleted.
  maybeGenerateCover(articleId).catch((coverErr) => {
    console.error(
      `[Cover] post-finalize hook crashed: articleId=${articleId}: ${coverErr?.message || coverErr}`,
    );
  });
}

/**
 * Экстренное завершение генерации fallback-контентом.
 * Используется, если LLM недоступен (502, network, нет ключа и т.д.).
 * W4.5: genTelemetry (опционально) — пер-ролевой дайджест в конце.
 */
async function finalizeWithFallback(article, articleId, structuredOutputs, job, reason, genTelemetry = null) {
  console.log(`[Worker] Finalizing article ${articleId} with fallback. Reason: ${reason}`);

  // W1.3 (2026-08-17, e2e-гэп от 16.08): skipFaq — только для ИСТИННОГО шаблона,
  // т.е. когда авторского вывода нет В МОМЕНТ входа в fallback (LLМ недоступна
  // с первых ролей — FAQ-вызов лишь добавил бы попытки ожидания по мёртвому
  // провайдеру). Если fallback происходит при живом авторском тексте (напр.,
  // таймаут фактчекера после успешного автора — все 3 прод-статьи), статья
  // полноценная и FAQ работает через обычную ветку: у faq-генератора есть
  // собственный fail-safe (любой сбой → WARN → статья без FAQ), а потеря
  // FAQ-секции готовой статьи дороже одного служебного вызова.
  // Флаг снимается ДО шаблонной генерации ниже (после неё author-ключ есть всегда).
  // FIX-M2 (2026-08-17): mid-pipeline шаблон автора (transient-сбой на самой
  // роли) помечен _fallbackTemplate — он не «живой автор», FAQ по нему тоже
  // не генерим (LLM уже деградировала на момент шаблона).
  const authorOutput = structuredOutputs['article-author'];
  const skipFaq = !authorOutput || authorOutput._fallbackTemplate === true;

  // Если article-author ещё не отработал — сгенерируем fallback из структуры (или минимальный)
  if (!structuredOutputs['article-author']) {
    const fallbackData = generateFallbackArticle(structuredOutputs['structure-architect'], {
      articleTitle: article?.topic,
      projectTitle: '',
      specialistName: '',
      priceLabel: '',
    });

    const { postProcessArticle } = await import('../article-post-processor.mjs');
    const ppResult = postProcessArticle({
      parsed: fallbackData,
      targetLength: article?.targetLength,
      keyPoints: collectKeyPointsFromStructure(structuredOutputs['structure-architect']),
    });
    // U4: постпроцессор больше не меняет текст (FAQ-вставка удалена) —
    // метрики объёма идут в лог, шаблон сохраняется как есть.
    if (ppResult.ok) {
      structuredOutputs['article-author'] = ppResult.result.parsed;
      console.log(
        `[Worker] Emergency fallback post-process: chars=${ppResult.result.postProcessed?.totalChars}/${ppResult.result.postProcessed?.targetChars}, shortSections=${ppResult.result.postProcessed?.shortSections?.length ?? 0}`
      );
    } else {
      structuredOutputs['article-author'] = fallbackData;
    }
  }

  // W1.3: skipFaq=true только для истинного шаблона (см. флаг выше) — при живом
  // авторском тексте FAQ идёт обычной веткой saveFinalVersion с fail-safe.
  // W2.2: постчек-отчёт создаётся внутри saveFinalVersion (в т.ч. здесь);
  // enforce-решение — в finalizeCompleted, как и в нормальном пути.
  // finalizedVia='fallback' — метрика PROCESS-FINALIZATION постчека.
  const fallbackFinalizeInfo = await saveFinalVersion(article, articleId, structuredOutputs, {
    skipFaq,
    finalizedVia: 'fallback',
  });
  await finalizeCompleted(articleId, job, fallbackFinalizeInfo);
  if (genTelemetry) logGenerationDigest(articleId, genTelemetry); // W4.5
}

/**
 * W4.2 (2026-08-17) + W-retry (2026-08-21): честная финализация при исчерпании
 * wall-clock бюджета ПОСЛЕДНЕЙ попытки прогона. Семантика — как у исчерпания
 * quality-retries: есть контент (>500 chars) → saveFinalVersion + needs_review
 * с причиной «Превышен бюджет времени генерации … попытки исчерпаны (M)»;
 * контента нет → failed + unrecoverable (очередь не должна ретраить полный
 * прогон, который уже упёрся в бюджет; повторы делает сам ретрай-цикл W-retry).
 *
 * @param {object} opts — { role, step, genTelemetry, maxAttempts } — роль,
 *   ПЕРЕД которой остановились (для прогресса/логов), телеметрия дайджеста и
 *   число попыток для текста причины.
 */
async function finalizeWallClockExhausted(article, articleId, structuredOutputs, job, { role, step, genTelemetry, maxAttempts = getGenerationMaxAttempts() }) {
  const elapsedMs = Date.now() - genTelemetry.startedAtMs;
  console.error(
    `[Worker] ${WALL_CLOCK_EXHAUSTED_REASON}: articleId=${articleId}, ${elapsedMs}ms ≥ ${getGenerationWallClockMs()}ms — останавливаемся перед ролью «${role?.nameRu || '?'}» (шаг ${step}).`
  );

  let savedNeedsReview = false;
  try {
    const bestContent = extractFinalArticle(structuredOutputs);
    if (bestContent?.content && bestContent.content.length > 500) {
      console.log(
        `[Worker] ${WALL_CLOCK_EXHAUSTED_REASON}, но есть контент (${bestContent.content.length} chars) → сохраняем как needs_review`
      );
      // finalizedVia='wall_clock' — постчек честно пометит PROCESS-FINALIZATION
      // (статья не прошла полный конвейер).
      await saveFinalVersion(article, articleId, structuredOutputs, { finalizedVia: 'wall_clock' });
      await prisma.article.update({
        where: { id: articleId },
        // U3: причина «бюджет времени» персистится — UI больше не атрибутирует
        // этот needs_review постчек-фейлам (жалоба U3: «непонятная причина»).
        // W-retry: в причине — сколько попыток исчерпано.
        data: { status: 'needs_review', needsReviewReason: wallClockReason(maxAttempts) },
      });
      sendProgress(
        buildProgressPayload({
          articleId,
          // Финальный кадр прогона (статья сохранена, нужен человек):
          // percent=100 и currentStage=totalStages — иначе клиент видел
          // «прогон завершён» на 45–82 % и считал шаг незавершённым.
          currentStage: TOTAL_STAGES,
          stageName: 'Требуется проверка',
          agentName: role?.id || 'system',
          description: 'Контент сохранён, требуется ручная проверка (бюджет времени)',
          percent: 100,
          status: 'completed',
          message: `${WALL_CLOCK_EXHAUSTED_REASON} — контент сохранён для ручной проверки (needs_review).`,
        })
      );
      savedNeedsReview = true;
    }
  } catch (saveErr) {
    console.error(
      `[Worker] saveFinalVersion(wall-clock) упал: ${saveErr?.message || saveErr}. Падаем в failed.`
    );
  }

  logGenerationDigest(articleId, genTelemetry); // W4.5

  // Cover checkbox wave: the wall-clock path NEVER builds a
  // cover (the text is not finished and a cover prompt is built from it) —
  // a pending request is consumed as skipped/cover_empty_article instead of
  // hanging as «Обложка после генерации» forever (risk R4). Articles without
  // a request stay untouched (no badge noise). Best-effort: never breaks the
  // wall-clock finalization itself.
  try {
    const coverState = await prisma.article.findUnique({
      where: { id: articleId },
      select: { coverRequested: true },
    });
    if (coverState?.coverRequested === true) {
      await prisma.article.update({
        where: { id: articleId },
        data: {
          coverRequested: false,
          coverStatus: 'skipped',
          coverSkipReason: 'cover_empty_article',
        },
      });
    }
  } catch (coverErr) {
    console.error(
      `[Cover] wall-clock cover-request reset failed: articleId=${articleId}: ${coverErr?.message || coverErr}`,
    );
  }

  if (savedNeedsReview) return; // статья сохранена, job завершается штатно

  const failReason = `${WALL_CLOCK_EXHAUSTED_REASON} (нет валидного контента для сохранения)`;
  await prisma.article.update({
    where: { id: articleId },
    data: { status: 'failed' },
  });
  sendProgress(
    buildProgressPayload({
      articleId,
      currentStage: step,
      stageName: role?.nameRu || 'Генерация',
      agentName: role?.id || 'system',
      description: 'Бюджет времени генерации исчерпан',
      percent: Math.round((step / TOTAL_STAGES) * 100),
      status: 'error',
      message: failReason,
    })
  );
  throw unrecoverable(failReason);
}

/* ------------------------------------------------------------------ */
/*  Фабрика worker                                                     */
/* ------------------------------------------------------------------ */

export function createArticleGenerationWorker() {
  // M1: register the handler on the in-process shim queue instead of
  // constructing a queue worker. The 'generate' job name is the only name the
  // /start route enqueues. Returned object keeps the close() shutdown surface.
  // M2: the topic-picking ledger reconciliation that lived on the old
  // queue 'failed' event is removed with the rest of that tree.
  const worker = {
    close: async () => {
      await articleGenerationQueue.close();
    },
  };

  articleGenerationQueue.process('generate', processArticleGeneration);

  // Settings audit (2026-10-26): подтягиваем правки промптов агентских
  // ролей в кэш рантайма. Fire-and-forget: падение БД не должно ронять воркер —
  // тогда агенты работают по статическому каталогу.
  loadAgentRoleOverrides().catch((err) => {
    console.error('[AgentRoles] worker overrides load failed:', err?.message || err);
  });

  // M1: completion/failure logging moved into the shim (it owns the runner
  // loop). M2 removed the ledger/enqueue side together with the tree.

  console.log('[Worker] Article generation worker initialized (in-process runner)');
  return worker;
}
