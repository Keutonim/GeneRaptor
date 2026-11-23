import { agentRoleData, agentRoleMap } from './agent-role-data.mjs';
import {
  buildRoleContractInstruction,
  normalizeStructuredRoleOutput,
  summarizeStructuredRoleOutput,
} from './agent-role-contracts.mjs';
// ── Внешние источники (evidence-слой) — рендерится в user-сообщение ролей ──
// renderResearchSourcesBlock создаётся Поперечной задачей A (Agent A).
import { renderResearchSourcesBlock } from './lib/research-source.mjs';
// Defensive strip: убирает inline-маркеры {{src:N}} из черновиков, которые
// рендерятся в user-сообщения ролей после фактчекера. Без этого барьера
// seo-reviewer / quality-controller / humanizer могут увидеть маркеры, если
// context.authorDraft (исходный, с маркерами) прокинут в user-сообщение.
import { stripCitations } from './lib/strip-citations.mjs';
// seo-round W0/A3: объёмно-зависимые сечки SEO-ядра и числа для автора —
// единый источник порогов (server/lib/seo-standards.mjs), не локальные константы.
import { semanticCoreCaps } from './lib/seo-standards.mjs';
// P2-1: pure RU canon renderer for Regulation rows — fed into
// the knowledge-base-curator + factchecker payloads (gating pattern below).
import { renderRegulationsBlock } from './lib/regulation-block.mjs';
// Settings audit (2026-10-26): пользовательские правки systemPrompt.
// Кэш в памяти (БД читается асинхронно), подстановка — СИНХРОННАЯ, чтобы
// buildRoleExecutionMessages оставалась синхронной.
import { applyAgentRoleOverride } from './lib/agent-role-overrides.mjs';
// M3: единственный LLM-call-site резолвит эндпоинт/ключ/модели
// из АКТИВНОГО провайдера (ProviderConfig → env-fallback). Ключи провайдера
// никогда не логируются — см. server/lib/providers.mjs (D10).
import {
  resolveActiveProviderForEngine,
  missingProviderKeyError,
  pinnedTierModel,
} from './lib/providers.mjs';

const DEFAULT_CRITICAL_MODEL = process.env.ROUTERAI_MODEL_CRITICAL || 'qwen/qwen3.7-plus';
const DEFAULT_GENERATION_MODEL = process.env.ROUTERAI_MODEL_GENERATION || 'qwen/qwen3.6-flash';
const DEFAULT_STANDARD_MODEL = process.env.ROUTERAI_MODEL_STANDARD || 'deepseek/deepseek-v4-flash';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 4000;

// ── SEO-ядро (P1, 2026-08-16): компактная выжимка семантики для заголовков ──
// Строится в worker'е после semantic-strategist (см. article-generation.mjs,
// блок «Прокидываем ПОЛНЫЕ черновики») и рендерится ТОЛЬКО structure-architect
// (планирует вхождения ключей в H1/H2/H3) и seo-reviewer (проверяет проценты
// и переспам). article-author получает только mainQueryRu. Остальные роли
// блок не видят: payload не растёт.
// M2: частотные ключи убраны — semantic-strategist единственный источник ядра.
// Сечки (seo-round A3): кластеры/LSI/FAQ-интенты — плоские SEO-default 10/12/8
// (объёмной нормы для них в server/lib/seo-standards.mjs нет).
export function buildSemanticCoreContext(semanticStrategistData, targetLength) {
  const caps = semanticCoreCaps(targetLength);
  const data = semanticStrategistData && typeof semanticStrategistData === 'object'
    ? semanticStrategistData
    : {};
  return {
    mainQueryRu: asNonEmptyString(data.mainQueryRu),
    queryClustersRu: Array.isArray(data.queryClustersRu) ? data.queryClustersRu.slice(0, caps.clusters) : [],
    lsiTermsRu: Array.isArray(data.lsiTermsRu) ? data.lsiTermsRu.slice(0, caps.lsi) : [],
    faqIntentsRu: Array.isArray(data.faqIntentsRu) ? data.faqIntentsRu.slice(0, caps.faqIntents) : [],
  };
}

/** Кластер {clusterRu, queriesRu[]} → «Название: запрос1, запрос2» (компактно). */
function formatQueryCluster(cluster) {
  if (typeof cluster === 'string') return cluster.trim();
  if (!cluster || typeof cluster !== 'object') return '';
  const name = asNonEmptyString(cluster.clusterRu);
  const queries = asStringList(cluster.queriesRu);
  if (name && queries.length) return `${name}: ${queries.join(', ')}`;
  return name || queries.join(', ');
}

function renderSemanticCoreBlock(semanticCore) {
  if (!semanticCore || typeof semanticCore !== 'object') return '';
  const lines = [];
  const mainQueryRu = asNonEmptyString(semanticCore.mainQueryRu);
  if (mainQueryRu) lines.push(`- Главный запрос (mainQueryRu): ${mainQueryRu}`);
  const clusters = Array.isArray(semanticCore.queryClustersRu)
    ? semanticCore.queryClustersRu.map(formatQueryCluster).filter(Boolean)
    : [];
  if (clusters.length) lines.push(`- Кластеры запросов: ${clusters.join('; ')}`);
  const lsi = asStringList(semanticCore.lsiTermsRu);
  if (lsi.length) lines.push(`- LSI-термины: ${lsi.join('; ')}`);
  const faq = asStringList(semanticCore.faqIntentsRu);
  if (faq.length) lines.push(`- FAQ-интенты: ${faq.join('; ')}`);
  if (!lines.length) return '';
  return ['🎯 SEO-ядро статьи (опора для заголовков H1/H2/H3):', ...lines].join('\n');
}

function asNonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

// ── P2-1: structured price rendering ──────────────────────
// Canonical RU price body from the Service priceMin/priceMax/priceCurrency
// columns: «5 000–7 000 ₽» / «от 5 000 ₽» / «до 7 000 ₽». Deterministic
// thousands grouping (plain space — no ICU dependency), RUB renders as ₽,
// any other ISO-4217 code renders as-is, missing currency renders no marker.
// '' when neither bound is a non-negative integer — the caller then keeps
// the legacy priceText fallback (byte-identical output for old rows).
function formatStructuredPriceBody(min, max, currency) {
  const minInt = Number(min);
  const maxInt = Number(max);
  const hasMin = Number.isInteger(minInt) && minInt >= 0;
  const hasMax = Number.isInteger(maxInt) && maxInt >= 0;
  if (!hasMin && !hasMax) return '';
  const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cur = asNonEmptyString(currency).toUpperCase();
  const suffix = cur === 'RUB' ? ' ₽' : cur ? ` ${cur}` : '';
  let body;
  if (hasMin && hasMax) {
    body = minInt === maxInt ? group(minInt) : `${group(minInt)}–${group(maxInt)}`;
  } else if (hasMin) {
    body = `от ${group(minInt)}`;
  } else {
    body = `до ${group(maxInt)}`;
  }
  return `${body}${suffix}`;
}

// ── P2-3: ranked candidates for topic-selector ────────────
// Renders the «Ранжированные кандидаты» block referenced by the frozen
// REVENUE-РАНЖИРОВАНИЕ directive of the topic-selector system prompt
// (agent-role-data.mjs, verbatim line). Inert by design: absent key
// or empty array → '' → the block is omitted (BP-5 single-shot path never
// sees it). Items: {topic, frequency, score} from the suggest-topic route.
function renderRankedCandidatesBlock(rankedCandidates) {
  if (!Array.isArray(rankedCandidates) || rankedCandidates.length === 0) return '';
  const lines = rankedCandidates
    .map((c) => {
      const topic = asNonEmptyString(c?.topic);
      if (!topic) return '';
      const freq = Number.isFinite(Number(c?.frequency))
        ? `спрос ${Number(c.frequency)} показов/мес`
        : 'спрос неизвестен';
      const score = Number.isFinite(Number(c?.score))
        ? `, score ${Number(c.score).toFixed(3)}`
        : '';
      return { topic, line: `${topic} — ${freq}${score}` };
    })
    .filter(Boolean);
  if (!lines.length) return '';
  // Numbered list: the ordinal IS the ranking (top position = best demand +
  // revenue score) the frozen REVENUE-РАНЖИРОВАНИЕ directive refers to.
  const numbered = lines.map((item, index) => `${index + 1}. ${item.line}`);
  return [
    '🏆 Ранжированные кандидаты (спрос + выгода компании; выбирай преимущественно из верхних позиций):',
    ...numbered,
  ].join('\n');
}

function formatValue(value, fallback = 'Не указано') {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || fallback;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value == null) {
    return fallback;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item == null) return '';
        try {
          return JSON.stringify(item, null, 2);
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${formatValue(item, '')}`.trim())
      .filter(Boolean);
  }

  return [];
}

function clampNumber(value, fallback, min, max) {
  const resolved = Number(value);
  if (!Number.isFinite(resolved)) return fallback;
  return Math.min(max, Math.max(min, resolved));
}

/**
 * FIX-F2 (QA W4, 2026-08-17): единый env-гвард числовых настроек (паттерн
 * W1.5). Number('') === 0 — пустая строка в env (ключ есть, значения нет)
 * молча превращалась в «0 ретраев» / «1с бюджет» вместо дефолта. Хелпер
 * возвращает дефолт при null/undefined/пустой-или-пробельной строке/NaN/
 * не-числе; валидные числа (вкл. 0 — легальный override) проходят как есть.
 * Клампы (min/max) остаются на caller'ах — у каждой настройки свои границы.
 */
export function resolveEnvNumber(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildPreviousOutputsSection(previousOutputs) {
  const normalized = asStringList(previousOutputs);
  if (!normalized.length) {
    return 'Предыдущие результаты ролей пока не переданы. Если ты стартовая роль, работай только по входному контексту ниже.';
  }

  return normalized.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function buildReadinessContextSection({ readinessContext, sourceReadiness, projectPreflightReport, pipelineReadinessSummaryRu } = {}) {
  const lines = [];
  const sourceStatus = asNonEmptyString(readinessContext?.sourceStatusRu, asNonEmptyString(sourceReadiness?.statusRu));
  const preflightStatus = asNonEmptyString(readinessContext?.preflightStatusRu, asNonEmptyString(projectPreflightReport?.statusRu));
  const blockersCount = Number(readinessContext?.blockersCount ?? projectPreflightReport?.blockersCount ?? 0);
  const warningsCount = Number(readinessContext?.warningsCount ?? 0);
  const sourceSummary = asNonEmptyString(sourceReadiness?.summaryRu);
  const contextSummary = asNonEmptyString(readinessContext?.summaryRu, asNonEmptyString(pipelineReadinessSummaryRu));

  if (sourceStatus) lines.push(`- Источник: ${sourceStatus}${sourceSummary ? `; ${sourceSummary}` : ''}`);
  if (preflightStatus) lines.push(`- Выпуск: ${preflightStatus}; блокеров ${blockersCount}; предупреждений ${warningsCount}`);
  if (contextSummary) lines.push(`- Сводка: ${contextSummary}`);

  return lines.length ? lines.join('\n') : '- Контекст готовности пока не передан.';
}

// ── Каталог всех услуг/специалистов источника (source-grounded fact-checking) ──
// Рендерит компактный список канонических названий для фактчекера. Сечка по лимиту:
// 40 услуг / 20 специалистов — контролируем payload (~3KB максимум). description /
// indications / contraindications / credentials обрезаются, чтобы не раздувать блок.
// B2 (2026-08-25): compactSpecialists — режим для article-author: только
// специалисты, ФИО + должность + короткая специализация. БЕЗ pageUrl (инвариант
// И1: автор НИКОГДА не ставит ссылки сам — ссылки добавляет только линкер) и
// БЕЗ регалий (экономия payload автора; регалии остаются у фактчекера).
function renderCatalogBlock(services, specialists, { compactSpecialists = false } = {}) {
  const sections = [];
  if (!compactSpecialists && Array.isArray(services) && services.length) {
    const svcList = services.slice(0, 40).map((s) => {
      const parts = [s?.name].filter(Boolean);
      if (s?.description) parts.push(`описание: ${String(s.description).slice(0, 100)}`);
      if (s?.indications) parts.push(`показания: ${String(s.indications).slice(0, 80)}`);
      if (s?.contraindications) parts.push(`противопоказания: ${String(s.contraindications).slice(0, 80)}`);
      // P2-1: structured price part of the catalog card (worker
      // select carries the columns); absent columns → nothing appended,
      // output stays byte-identical for old rows.
      const catalogPriceBody = formatStructuredPriceBody(s?.priceMin, s?.priceMax, s?.priceCurrency);
      if (catalogPriceBody) parts.push(`цена: ${catalogPriceBody}`);
      if (s?.url) parts.push(`url: ${s.url}`);
      return `- ${parts.join(' | ')}`;
    }).join('\n');
    sections.push(`🏥 Канонические услуги источника (${services.length}, показано ${Math.min(40, services.length)}):\n${svcList}`);
  }
  if (Array.isArray(specialists) && specialists.length) {
    const specList = specialists.slice(0, compactSpecialists ? 12 : 20).map((s) => {
      const parts = [s?.fullName].filter(Boolean);
      if (s?.position) parts.push(s.position);
      if (compactSpecialists) {
        // Компакт: короткая специализация, БЕЗ регалий и БЕЗ pageUrl (И1).
        if (s?.specialization) parts.push(String(s.specialization).slice(0, 60));
      } else {
        if (s?.specialization) parts.push(s.specialization);
        if (s?.credentials) parts.push(`регалии: ${String(s.credentials).slice(0, 80)}`);
      }
      return `- ${parts.join(' | ')}`;
    }).join('\n');
    sections.push(`👨‍⚕️ Канонические специалисты источника (${specialists.length}, показано ${Math.min(compactSpecialists ? 12 : 20, specialists.length)}):\n${specList}`);
  }
  if (!sections.length) return '';
  const header = compactSpecialists
    ? '📋 КАТАЛОГ СПЕЦИАЛИСТОВ ИСТОЧНИКА (реальные специалисты компании — упоминай в тексте ТОЛЬКО их; ссылок тут нет и ставить их не нужно — ссылки добавит система)'
    : '📋 КАТАЛОГ ИСТОЧНИКА (для фактчекинга — сверяй факты об услугах/специалистах с этим списком)';
  return `\n\n${header}:\n${sections.join('\n\n')}`;
}

function extractTextFromContentPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

function extractTextFromMessage(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';

  if (typeof message.content === 'string') return message.content;

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => extractTextFromContentPart(part))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof message.text === 'string') return message.text;
  return '';
}

function extractFirstChoice(response) {
  if (!response || typeof response !== 'object') return null;
  if (Array.isArray(response.choices) && response.choices.length) return response.choices[0];
  if (Array.isArray(response.output) && response.output.length) return response.output[0];
  return null;
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.trim();
  if (!normalized) return null;

  const candidates = [normalized];
  const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) candidates.push(fencedMatch[1].trim());

  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    if (!(candidate.startsWith('{') || candidate.startsWith('['))) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }

  return null;
}

export function getExecutableRole(roleId) {
  const normalizedRoleId = asNonEmptyString(roleId);
  const role = agentRoleMap.get(normalizedRoleId);
  if (!role) {
    const knownRoleIds = agentRoleData.map((item) => item.id).join(', ');
    throw new Error(`Неизвестная агентская роль: ${normalizedRoleId || 'empty-role-id'}. Доступные роли: ${knownRoleIds}`);
  }

  return {
    ...role,
    inputs: role.inputs.slice(),
    outputs: role.outputs.slice(),
    nextRoleIds: role.nextRoleIds.slice(),
  };
}

export function resolveRoleModel(role, { criticalModel, generationModel, standardModel } = {}) {
  const executableRole = role?.id ? role : getExecutableRole(role);
  const resolvedCriticalModel = asNonEmptyString(criticalModel, DEFAULT_CRITICAL_MODEL);
  const resolvedGenerationModel = asNonEmptyString(generationModel, DEFAULT_GENERATION_MODEL);
  const resolvedStandardModel = asNonEmptyString(standardModel, DEFAULT_STANDARD_MODEL);

  const tier = executableRole.modelTier;
  if (tier === 'critical') return resolvedCriticalModel;
  if (tier === 'generation') return resolvedGenerationModel;
  // Backward-compat: legacy 'hard' tier maps to 'critical' (strongest reasoning).
  if (tier === 'hard') return resolvedCriticalModel;
  return resolvedStandardModel;
}

export function resolveRoleMaxTokens(roleId, articleLength) {
  // DeepSeek-v4-pro (hard tier) spends a large reasoning_tokens budget BEFORE
  // emitting any `content`. With small max_tokens the reasoning phase eats the
  // whole budget and the visible `content` stays empty — worker then reports
  // "модель не вернула содержательный ответ" even though the call succeeded.
  // The limits below leave headroom for reasoning + full structured JSON.
  //
  // article-author: динамический лимит под targetLength, т.к. статей 50k+ chars
  // нужно ~14000 output tokens (50k ÷ 3.5 chars/ru-token). Для chunked-режима
  // каждая секция ≤6000 (см. worker — передаёт maxTokens явно).
  // factchecker/humanizer: 14000 — теперь работают с ПОЛНОЙ статьёй
  // (factchecker возвращает переписанный текст, humanizer — стилизованный).
  if (roleId === 'article-author') {
    if (Number.isFinite(Number(articleLength)) && Number(articleLength) > 0) {
      // ~3 chars на русский токен + headroom. Clamp [8000, 16000].
      return Math.min(16000, Math.max(8000, Math.ceil(Number(articleLength) / 3)));
    }
    return 9000; // fallback — неизвестен targetLength
  }

  // All 11 roles are explicitly listed — none falls back to DEFAULT_MAX_TOKENS.
  // Reasoning models (deepseek/qwen) spend reasoning_tokens BEFORE content;
  // a tight budget causes `finish_reason=length` with empty/short structured JSON.
  // Audit round 2026-08-10 (local workspace artefact): the per-role budget
  // below is its frozen outcome.
  const roleMaxTokens = {
    'topic-selector': 5000,
    'brief-preparer': 5000,
    'knowledge-base-curator': 6500,
    'research-analyst': 8000,
    'semantic-strategist': 5000,
    'structure-architect': 8000,
    'article-author': 8000, // per-chunk; worker overrides via SECTION_MAX_TOKENS
    'factchecker': 14000,
    'seo-reviewer': 8000,
    'quality-controller': 6000,
    'humanizer': 14000,
  };
  return roleMaxTokens[roleId] || DEFAULT_MAX_TOKENS;
}

export function buildRoleExecutionMessages({
  roleId,
  sourceId,
  projectTitle,
  articleTitle,
  specialistName,
  serviceName,
  priceLabel,
  // ── P2-1: structured price of the linked service (DB truth)
  // ── renders the canonical truth-card line; priceText stays the fallback.
  servicePriceMin,
  servicePriceMax,
  servicePriceCurrency,
  companyProfileText,
  // seo-round TL (шов Dev-A/Dev-B): точное название компании из sourceSite.name —
  // единственный источник имени (БД). Правило «УПОМИНАНИЯ КОМПАНИИ» промпта
  // автора опирается на строку ниже; без неё (companyProfileText пуст) автор
  // писал бы «наша компания», а постчек со счётчиком упоминаний бренда считал бы 0
  // упоминаний sourceSite.name → ложный major-fail.
  companyName,
  articleLength,
  readinessContext,
  sourceReadiness,
  projectPreflightReport,
  pipelineReadinessSummaryRu,
  previousOutputs,
  // ── Source grounding: rich-поля (источник правды) ──
  serviceDescription,
  serviceIndications,
  serviceContraindications,
  serviceUrl,
  specialistPosition,
  specialistSpecialization,
  specialistExperience,
  specialistCredentials,
  specialistAuthorSignature,
  // ── B3 (2026-08-25): «Уточнения» владельца статьи (article.userNotes) ──
  // Рендерится ТОЛЬКО article-author + brief-preparer (см. showUserNotes ниже):
  // приоритетны для акцентов/подачи, НЕ отменяют профессиональную корректность и SEO.
  userNotes,
  // ────────────────────────── D6 (GeneRaptor): язык материала статьи —
  // параметр генерации ('ru' | 'en', дефолт ru). Управляет языком ВЫХОДА ролей
  // (директива в «Формат ответа» + строка в контексте проекта); домен и RU-
  // специализация промптов не меняются (D7).
  language,
  // ── Внешние источники (evidence-слой) — рендерится после specialistCard ──
  externalResearch,
  // ── SEO-ядро (P1, 2026-08-16): компактная семантика для заголовков ──
  // Рендерится только structure-architect + seo-reviewer (см. showSemanticCore);
  // автору из ядра достаётся только mainQueryRu.
  semanticCore,
  // ── Каталог всех услуг/специалистов источника (source-grounded fact-checking) ──
  // Рендерится только фактчекеру (см. needsCatalogBlock ниже), чтобы не раздувать
  // payload остальных ролей.
  catalogServices,
  catalogSpecialists,
  // ── P2-1: Regulation rows (kind/title/url/service scope) ──
  // Рендерятся ТОЛЬКО knowledge-base-curator + factchecker (gating-паттерн
  // каталога): регламенты/протоколы/лицензии — канон для куриратора БЗ и
  // фактчекинга. Пусто/нет ключа → блок опущен чисто (QA-инвариант 10).
  catalogRegulations,
  // ── P2-3: ranked candidate topics ({topic, frequency,
  // score}, топ-K) с роута suggest-topic (phase 2). Рендерится ТОЛЬКО
  // topic-selector; отсутствие ключа (BP-5, ручные статьи) → блок опущен,
  // директива REVENUE-РАНЖИРОВАНИЕ промпта инертна.
  rankedCandidates,
  // ── Передача полных черновиков между ролями ──
  authorDraft,
  authorClaims,
  authorRiskyPhrases,
  structureSections,
  factcheckedDraft,
  // ── Quality-gate retry-loop feedback для article-author ──
  qualityFeedback,
} = {}) {
  const role = applyAgentRoleOverride(getExecutableRole(roleId));
  let systemPrompt = asNonEmptyString(role.systemPrompt, 'Ты служебный агент проекта GeneRaptor.');
  if (articleLength !== undefined && articleLength !== null) {
    systemPrompt = systemPrompt.replace(/\{\{articleLength\}\}/g, String(articleLength));
  }

  // ── Карточка услуги (источник правды) ──
  // P2-1: structured price line wins when the DB carries it
  // («Цена: 5 000–7 000 ₽»); без структурированных колонок — легаси-строка
  // priceText, байт-в-байт как раньше (QA-инвариант «old rows unchanged»).
  const structuredPriceBody = formatStructuredPriceBody(servicePriceMin, servicePriceMax, servicePriceCurrency);
  const serviceCard = [
    '📋 Карточка услуги (источник правды):',
    `- Название: ${formatValue(serviceName)}`,
    `- Описание: ${formatValue(serviceDescription)}`,
    `- Показания: ${formatValue(serviceIndications)}`,
    `- Противопоказания: ${formatValue(serviceContraindications)}`,
    ...(structuredPriceBody
      ? [`- Цена: ${structuredPriceBody}`]
      : [`- Цена: ${formatValue(priceLabel)}`]),
    `- URL: ${formatValue(serviceUrl)}`,
  ].join('\n');

  // ── Карточка специалиста (источник правды) ──
  const specialistCard = [
    '👨‍⚕️ Карточка специалиста (источник правды):',
    `- ФИО: ${formatValue(specialistName)}`,
    `- Должность: ${formatValue(specialistPosition)}`,
    `- Специализация: ${formatValue(specialistSpecialization)}`,
    `- Опыт: ${formatValue(specialistExperience)}`,
    `- Регалии: ${formatValue(specialistCredentials)}`,
  ].join('\n');

  // ── Внешние источники (evidence-слой) ──
  // Рендерится только если массив непустой; пустой массив → пустая строка →
  // блок не попадает в user-сообщение (роли работают по карточкам как раньше).
  const externalResearchBlock = renderResearchSourcesBlock(externalResearch);

  // ── SEO-ядро (P1, 2026-08-16) ──
  // Видимость ограничена: structure-architect планирует вхождения ключей в
  // заголовки H1/H2/H3, seo-reviewer проверяет 30–50% и переспам. Остальные
  // роли блок не получают — payload не растёт. Автору — только mainQueryRu.
  const showSemanticCore = roleId === 'structure-architect' || roleId === 'seo-reviewer';
  const semanticCoreBlock = showSemanticCore ? renderSemanticCoreBlock(semanticCore) : '';
  const authorMainQueryRu = roleId === 'article-author'
    ? asNonEmptyString(semanticCore?.mainQueryRu)
    : '';

  // ── Каталог всех услуг/специалистов источника (для фактчекинга + выбора темы) ──
  // Рендерится фактчекеру (каталог нужен, чтобы сверять упоминания услуг/
  // оборудования/специалистов с каноном компании) и topic-selector'у (чтобы выбирать тему
  // из РЕАЛЬНЫХ услуг источника, а не выдумывать услуги). Остальным ролям
  // блок не нужен и не должен раздувать payload (54 услуги × ~60 символов ≈ 3KB).
  // B2 (2026-08-25): + article-author — компактный каталог СПЕЦИАЛИСТОВ (без
  // pageUrl/регалий), чтобы автор в режиме «специалист не выбран» упоминал
  // РЕАЛЬНЫХ экспертов компании (И3), а не выдумывал имена.
  const needsCatalogBlock =
    roleId === 'factchecker' || roleId === 'topic-selector' || roleId === 'article-author';
  const catalogBlock = needsCatalogBlock
    ? renderCatalogBlock(catalogServices, catalogSpecialists, {
        compactSpecialists: roleId === 'article-author',
      })
    : '';

  // ── P2-1: regulations canon — gating-паттерн каталога: ────
  // только knowledge-base-curator + factchecker; renderRegulationsBlock сам
  // возвращает '' на пустом списке → блок опущен чисто, payload не растёт.
  const needsRegulationsBlock =
    roleId === 'knowledge-base-curator' || roleId === 'factchecker';
  const regulationsBlock = needsRegulationsBlock
    ? renderRegulationsBlock(catalogRegulations)
    : '';

  // ── P2-3: ranked candidates — только topic-selector; ──────
  // инертен без ключа (ручные статьи воркера / BP-5) — блок не рендерится.
  const rankedCandidatesBlock = roleId === 'topic-selector'
    ? renderRankedCandidatesBlock(rankedCandidates)
    : '';

  // ── B2 (2026-08-25): голос повествования автора — ДИНАМИЧЕСКИЙ режим-маркер ──
  // Статические инструкции обоих режимах — в systemPrompt автора
  // (agent-role-data.mjs, «ГОЛОС ПОВЕСТВОВАНИЯ»); здесь выбирается АКТИВНЫЙ
  // режим по truthiness specialistName (воркер кладёт article.specialist.*
  // в контекст). Без каталога ≥2 специалистов инструкция упоминаний не даём.
  const catalogSpecialistCount = Array.isArray(catalogSpecialists) ? catalogSpecialists.length : 0;
  let authorVoiceBlock = '';
  if (roleId === 'article-author') {
    if (asNonEmptyString(specialistName)) {
      authorVoiceBlock = [
        '🎙️ ГОЛОС ПОВЕСТВОВАНИЯ — активный режим: СПЕЦИАЛИСТ ВЫБРАН.',
        'Статья от лица компании (безлично-профессионально), НО добавь 2–3 короткие вставки от первого лица выбранного специалиста — личные рекомендации/наблюдения из практики. Единый шаблон вставки: «💡 {Имя} {Отчество}, {должность}: {рекомендация}» (имя/отчество/должность — из карточки специалиста выше). Вставляй вставки в тематически уместные места статьи, НЕ в конец. НЕ подписывайся в конце — подпись добавит система.',
      ].join('\n');
    } else if (catalogSpecialistCount >= 2) {
      authorVoiceBlock = [
        '🎙️ ГОЛОС ПОВЕСТВОВАНИЯ — активный режим: СПЕЦИАЛИСТ НЕ ВЫБРАН.',
        'Пиши безлично от лица компании; продвигай компанию. Упомяни 2–4 РАЗНЫХ специалистов из каталога выше как экспертов компании (только реальные имена из каталога, НЕ выдумывай). markdown-ссылки на специалистов НЕ ставь — их добавит система отдельным шагом. НЕ подписывайся в конце.',
      ].join('\n');
    } else {
      authorVoiceBlock = [
        '🎙️ ГОЛОС ПОВЕСТВОВАНИЯ — активный режим: СПЕЦИАЛИСТ НЕ ВЫБРАН.',
        'Пиши безлично от лица компании; продвигай компанию. Каталог специалистов не передан или в нём меньше двух специалистов — никого по имени не выдумывай. НЕ подписывайся в конце — подпись добавляет система.',
      ].join('\n');
    }
  }

  // ── B3 (2026-08-25): «Уточнения» владельца — только author + brief-preparer ──
  // Изолированный блок-цитата с явным статусом приоритета (риск R14: кап 1000
  // симв на входе делает роут; здесь только рендер после trim).
  // ── D6: директивы языка материала. ru — байт-паритет с прежним поведением
  // (строка «Формат ответа» не менялась); en — переключает выходной язык.
  const materialLanguage = language === 'en' ? 'en' : 'ru';
  const LANGUAGE_FORMAT_LINE = {
    ru: '- Пиши полностью на русском языке.',
    en: '- Пиши полностью на английском языке (язык материала: en) — ВСЕ текстовые поля контракта, заголовки и текст статьи на английском.',
  };
  const languageContextLine = materialLanguage === 'en'
    ? '- Язык материала: английский (en) — вся статья и все текстовые поля на английском языке'
    : '';

  const userNotesText = asNonEmptyString(userNotes);
  const showUserNotes = userNotesText && (roleId === 'article-author' || roleId === 'brief-preparer');
  const userNotesBlock = showUserNotes
    ? `📝 ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА (приоритетны для акцентов и подачи; НЕ отменяют профессиональную корректность, факты и SEO-ядро):\n«${userNotesText}»`
    : '';

  // ── Полный черновик автора (для factchecker / humanizer) ──
  // DEFENSIVE STRIP 2026-07-12: маркеры {{src:N}} разрешены ТОЛЬКО фактчекеру
  // (он их проверяет). Для всех остальных ролей (seo-reviewer, quality-controller,
  // humanizer) — strip, чтобы ни одна роль после
  // factchecker'а не увидела маркеры в user-сообщении. Это устраняет утечку:
  // feedback quality-controller'а «В тексте присутствуют маркеры {{src:1}}…».
  const needsAuthorDraftRaw = roleId === 'factchecker';
  const draftSections = [];
  if (asNonEmptyString(authorDraft)) {
    // factchecker видит оригинал с маркерами; остальные — strip-версию.
    const authorDraftForRole = needsAuthorDraftRaw ? authorDraft : stripCitations(authorDraft);
    const claimsBlock = asStringList(authorClaims);
    const riskyBlock = asStringList(authorRiskyPhrases);
    draftSections.push(
      '📝 Черновик статьи (полный текст, для проверки — не сокращай, работай по этому тексту):',
      '```markdown',
      authorDraftForRole,
      '```'
    );
    if (claimsBlock.length) {
      draftSections.push('', 'Тезисы автора для проверки фактчекером:', claimsBlock.map((c, i) => `${i + 1}. ${c}`).join('\n'));
    }
    if (riskyBlock.length) {
      draftSections.push('', 'Рискованные формулировки автора:', riskyBlock.map((c, i) => `${i + 1}. ${c}`).join('\n'));
    }
  }

  // ── Структура (полная, без обрезки до 3) для article-author ──
  if (Array.isArray(structureSections) && structureSections.length) {
    const sectionsText = structureSections
      .map((section, index) => {
        if (typeof section === 'string') return `${index + 1}. ${section}`;
        const heading = formatValue(section?.headingRu);
        const purpose = formatValue(section?.purposeRu);
        const keyPoints = asStringList(section?.keyPointsRu);
        const keyPointsText = keyPoints.length ? `\n   Key points: ${keyPoints.join('; ')}` : '';
        // formatRu (task T1, article-quality): structure-architect помечает
        // сравнительные секции formatRu: 'таблица' — пробрасываем маркер автору
        // (иначе контрактное поле до модели не доходит и таблица не появляется).
        const isTableFormat =
          typeof section?.formatRu === 'string' && section.formatRu.trim().toLowerCase() === 'таблица';
        const formatHint = isTableFormat ? ' (оформи таблицей)' : '';
        return `${index + 1}. ${heading}${formatHint} — цель: ${purpose}${keyPointsText}`;
      })
      .join('\n');
    draftSections.push(
      '',
      '🏗️ Структура статьи (полный план, реализуй ВСЕ разделы без пропусков):',
      sectionsText
    );
  }

  // ── Factchecked-черновик (для humanizer — стилизовать именно проверенную версию) ──
  // DEFENSIVE STRIP 2026-07-12: даже если worker уже снял маркеры с
  // context.factcheckedDraft, дублируем strip здесь — на случай если фактчекер
  // вернул новый текст с маркерами, а strip в worker'е не отработал (напр. при
  // retry-loop сбросе). Ни одна роль не должна видеть {{src:N}}.
  if (asNonEmptyString(factcheckedDraft)) {
    const cleanFactchecked = stripCitations(factcheckedDraft);
    draftSections.push(
      '',
      '📝 Статья после фактчекинга (полный текст — стилизуй именно эту версию, не возвращайся к черновику автора):',
      '```markdown',
      cleanFactchecked,
      '```'
    );
  }

  const userPrompt = [
    `Исполни роль «${role.nameRu}» для агентского контура GeneRaptor.`,
    '',
    'Работай только по входным данным этого сообщения. Ничего не выдумывай и не ссылайся на внешние источники, которых здесь нет.',
    '',
    'Контракт роли:',
    `- Идентификатор роли: ${role.id}`,
    `- Контур модели: ${role.modelTier === 'hard' ? 'сложный' : 'служебный'}`,
    `- Триггер запуска: ${role.trigger}`,
    `- Ожидаемые входы: ${role.inputs.join(', ')}`,
    `- Ожидаемые выходы: ${role.outputs.join(', ')}`,
    `- Критерий качества: ${role.qualityGate}`,
    '',
    'Контекст источника и проекта:',
    `- Источник: ${formatValue(sourceId, 'Источник не указан')}`,
    `- Проект: ${formatValue(projectTitle, 'Проект не указан')}`,
    // seo-round TL: явная строка компании — «Проект: …» неоднозначен как
    // источник названия (это может быть имя проекта, не компании), а
    // «Описание компании» (companyProfileText) у прод-источников пуст.
    ...(asNonEmptyString(companyName)
      ? [`- Компания (точное название для упоминаний в тексте): ${asNonEmptyString(companyName)}`]
      : []),
    ...(languageContextLine ? [languageContextLine] : []),
    `- Заголовок статьи: ${formatValue(articleTitle, 'Тема статьи пока не зафиксирована')}`,
    '',
    serviceCard,
    '',
    specialistCard,
    specialistAuthorSignature ? `- Подпись автора: ${formatValue(specialistAuthorSignature)}` : '',
    // ── B3: «Уточнения» владельца — только author + brief-preparer ──
    ...(userNotesBlock ? ['', userNotesBlock] : []),
    // ── Внешние источники (evidence-слой) — добавляем только если блок непустой ──
    ...(externalResearchBlock ? ['', externalResearchBlock] : []),
    // ── SEO-ядро (P1, 2026-08-16) — только structure-architect + seo-reviewer ──
    ...(semanticCoreBlock ? ['', semanticCoreBlock] : []),
    // ── Главный запрос автору (P1): полного ядра не даём ──
    ...(authorMainQueryRu
      ? ['', `🎯 Главный запрос статьи (SEO): ${authorMainQueryRu} — используй его в заголовке H1.`]
      : []),
    // ── Каталог источника — фактчекеру + topic-selector'у + автору (B2, компакт) ──
    ...(catalogBlock ? ['', catalogBlock] : []),
    // ── P2-1: регламенты/протоколы/лицензии — куриратору БЗ + фактчекеру ──
    ...(regulationsBlock ? ['', regulationsBlock] : []),
    // ── P2-3: ранжированные кандидаты — только topic-selector (BP-5-инертно) ──
    ...(rankedCandidatesBlock ? ['', rankedCandidatesBlock] : []),
    // ── B2: активный режим голоса повествования автора ──
    ...(authorVoiceBlock ? ['', authorVoiceBlock] : []),
    '',
    'Дополнительный контекст проекта:',
    articleLength ? `- Объем статьи: ${formatValue(articleLength, 'Объем не указан')}` : '',
    companyProfileText ? `- Описание компании: ${formatValue(companyProfileText, 'Описание компании не указано')}` : '',
    '',
    'Контекст готовности:',
    buildReadinessContextSection({ readinessContext, sourceReadiness, projectPreflightReport, pipelineReadinessSummaryRu }),
    '',
    'Результаты предыдущих ролей:',
    buildPreviousOutputsSection(previousOutputs),
  ];

  // Полные черновики добавляем в конец — это самые важные данные для проверки/стилизации
  if (draftSections.length) {
    userPrompt.push('', ...draftSections);
  }

  // ── Quality-gate retry-loop feedback: directive для article-author при перегенерации ──
  // Контролёр качества / фактчекер отклонили предыдущую версию — модель должна
  // знать ЧТО именно исправить. Feedback накапливается между попытками (worker
  // дописывает «--- ПРЕДЫДУЩАЯ ПОПЫТКА N ---»), поэтому автор видит ВСЕ прошлые
  // замечания и обязан не повторять ни одно из них.
  if (asNonEmptyString(qualityFeedback)) {
    userPrompt.push(
      '',
      '⚠️ ДИРЕКТИВА ПЕРЕГЕНЕРАЦИИ (контроль качества отклонил предыдущую версию).',
      'Это НЕ первая попытка. Ниже — накопленный список замечаний от ВСЕХ прошлых попыток ' +
        '(разделяются «--- ПРЕДЫДУЩАЯ ПОПЫТКА N ---»). Твоя задача — написать новую версию ' +
        'статьи, в которой ИСПРАВЛЕНО КАЖДОЕ из этих замечаний. Не повторяй прежние ошибки:',
      qualityFeedback,
      'ОБЯЗАТЕЛЬНО: перед отправкой статьи проверь её на КАЖДЫЙ пункт выше. Если хотя бы ' +
        'одно замечание не учтено — статья будет отклонена снова. Будь директивен с собой.'
    );
  }

  userPrompt.push(
    '',
    'Формат ответа:',
    LANGUAGE_FORMAT_LINE[materialLanguage],
    buildRoleContractInstruction(role.id)
  );

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt.join('\n') },
  ];
}

export function buildRoleExecutionPayload({
  roleId,
  context,
  criticalModel,
  generationModel,
  standardModel,
} = {}) {
  const role = getExecutableRole(roleId);
  const messages = buildRoleExecutionMessages({
    roleId: role.id,
    sourceId: context?.sourceId,
    projectTitle: context?.projectTitle,
    articleTitle: context?.articleTitle,
    specialistName: context?.specialistName,
    serviceName: context?.serviceName,
    priceLabel: context?.priceLabel,
    // ── P2-1: structured price truth-card line ──
    servicePriceMin: context?.servicePriceMin,
    servicePriceMax: context?.servicePriceMax,
    servicePriceCurrency: context?.servicePriceCurrency,
    companyProfileText: context?.companyProfileText,
    // seo-round TL: sourceSite.name → строка «Компания (точное название …)».
    companyName: context?.siteName,
    readinessContext: context?.readinessContext,
    sourceReadiness: context?.sourceReadiness,
    projectPreflightReport: context?.projectPreflightReport,
    pipelineReadinessSummaryRu: context?.pipelineReadinessSummaryRu,
    articleLength: context?.articleLength,
    previousOutputs: context?.previousOutputs,
    // ── Source grounding (источник правды) ──
    serviceDescription: context?.serviceDescription,
    serviceIndications: context?.serviceIndications,
    serviceContraindications: context?.serviceContraindications,
    serviceUrl: context?.serviceUrl,
    specialistPosition: context?.specialistPosition,
    specialistSpecialization: context?.specialistSpecialization,
    specialistExperience: context?.specialistExperience,
    specialistCredentials: context?.specialistCredentials,
    specialistAuthorSignature: context?.specialistAuthorSignature,
    // ── B3: «Уточнения» владельца статьи ──
    userNotes: context?.userNotes,
    // ── D6: язык материала статьи ──
    language: context?.language,
    // ── Внешние источники (evidence-слой) ──
    externalResearch: context?.externalResearch,
    // ── SEO-ядро (P1, 2026-08-16): строится воркером после semantic-strategist ──
    semanticCore: context?.semanticCore,
    // ── Каталог всех услуг/специалистов источника (source-grounded fact-checking) ──
    catalogServices: context?.catalogServices,
    catalogSpecialists: context?.catalogSpecialists,
    // ── P2-1: Regulation rows → curator/factchecker canon ──
    catalogRegulations: context?.catalogRegulations,
    // ── P2-3: ranked candidates → topic-selector block ──
    rankedCandidates: context?.rankedCandidates,
    // ── Полные черновики между ролями ──
    authorDraft: context?.authorDraft,
    authorClaims: context?.authorClaims,
    authorRiskyPhrases: context?.authorRiskyPhrases,
    structureSections: context?.structureSections,
    factcheckedDraft: context?.factcheckedDraft,
    // ── Quality-gate retry-loop feedback ──
    qualityFeedback: context?.qualityFeedback,
  });

  // Standard-роли на deepseek-v4-flash: reasoning-фаза может сжечь весь бюджет
  // max_tokens (22K+ reasoning tokens, 0 content) → finish_reason=length. Для
  // служебных ролей, где задача — прямая выборка/форматирование фактов из
  // контекста, reasoning не нужен. Отключаем явно (applyThinkingDisableIfNeeded
  // резолвится этим значением и не переопределяет).
  const NO_THINKING_ROLES = new Set([
    'knowledge-base-curator',
    'brief-preparer',
  ]);

  const payload = {
    model: resolveRoleModel(role, { criticalModel, generationModel, standardModel }),
    messages,
    temperature: clampNumber(context?.temperature, DEFAULT_TEMPERATURE, 0, 2),
    max_tokens: Math.round(clampNumber(context?.maxTokens ?? context?.max_tokens, resolveRoleMaxTokens(role.id, context?.articleLength), 1, 16000)),
  };

  if (NO_THINKING_ROLES.has(role.id)) {
    payload.enable_thinking = false;
  }

  return payload;
}

export function parseRoleExecutionResult({
  roleId,
  model,
  response,
  context,
} = {}) {
  const role = getExecutableRole(roleId);
  const choice = extractFirstChoice(response);
  const message = choice?.message ?? choice;
  const content =
    extractTextFromMessage(message) ||
    (typeof choice?.text === 'string' ? choice.text : '') ||
    (typeof response?.output_text === 'string' ? response.output_text : '') ||
    (typeof response?.text === 'string' ? response.text : '') ||
    '';
  const normalizedContent = content.trim();
  const parsedJson = tryParseJson(normalizedContent);
  const structured = normalizeStructuredRoleOutput(role.id, parsedJson, context);
  const finishReason =
    asNonEmptyString(choice?.finish_reason) ||
    asNonEmptyString(choice?.finishReason) ||
    asNonEmptyString(response?.finish_reason) ||
    asNonEmptyString(response?.finishReason) ||
    null;

  return {
    roleId: role.id,
    roleName: role.nameRu,
    model: asNonEmptyString(model, asNonEmptyString(response?.model, 'модель не указана')),
    content: normalizedContent,
    parsed: parsedJson,
    structured,
    structuredSummaryRu: parsedJson ? summarizeStructuredRoleOutput(role.id, parsedJson) : structured.summaryRu,
    finishReason,
    usage: response?.usage ?? null,
    refusal:
      asNonEmptyString(message?.refusal) ||
      asNonEmptyString(response?.refusal) ||
      null,
    raw: response ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  Реальный вызов LLM-провайдера (M3: routerai/openrouter/ollama/custom) */
/* ------------------------------------------------------------------ */

// M3: эндпоинт/ключ/тир-модели резолвятся НА КАЖДЫЙ вызов из
// активной конфигурации провайдера (server/lib/providers.mjs): включённая
// строка ProviderConfig → env-fallback ROUTERAI_* (headless/CI). Поведение
// для routerai-конфигурации без БД-строк идентично прежней конфигурации. Ключless-провайдеры
// (ollama) вызываются без Authorization-заголовка.

/**
 * Streaming-режим по умолчанию включён: SSE-чанки начинают приходить сразу,
 * поэтому прокси RouterAI не закрывает соединение на 60-секундном серверном
 * таймауте (non-streaming ответы >60с падают с `fetch failed` / Connection reset).
 * Поставьте ROUTERAI_STREAM=false для отката к обычному режиму.
 */
const ROUTERAI_STREAM_ENABLED = String(process.env.ROUTERAI_STREAM ?? 'true').toLowerCase() !== 'false';

/**
 * Qwen-модели через RouterAI тратят до 88% completion-токенов на reasoning
 * (research-2026-08-13: qwen3.6-flash = 1688 reasoning токенов из 2016).
 * Параметр `enable_thinking:false` проксируется в underlying Qwen-модель и
 * падает до 0 reasoning при идентичном content-выводе (14.8с → 2.9с, -80%).
 *
 * Глобально включается через `ROUTERAI_DISABLE_THINKING` (default `true` —
 * безопасно: reasoning для structured-output не нужен). Поставьте `false`
 * чтобы отключить оптимизацию (kill-switch при регрессии качества).
 *
 * Важно: НЕ применяется к deepseek — для них `enable_thinking` через RouterAI
 * не работает (reasoning растёт вместо падения, research Шаг 2).
 *
 * Env читается на каждый вызов (а не при import) — чтобы тесты и hot-reload
 * могли переопределять флаг без перезагрузки модуля.
 */
const QWEN_MODEL_PATTERN = /qwen/i;

function isThinkingDisableEnabled() {
  // Default: thinking ENABLED (рассуждения нужны для анализа каталога, фактчекинга, и т.д.).
  // Set ROUTERAI_DISABLE_THINKING=true to globally disable (experimental, quality drop on complex roles).
  return String(process.env.ROUTERAI_DISABLE_THINKING ?? 'false').toLowerCase() === 'true';
}

/**
 * Мутирует request-payload, добавляя `enable_thinking:false` для qwen-моделей,
 * если caller не задал значение явно и env-флаг разрешает оптимизацию.
 * Возвращает тот же объект для chainability.
 */
function applyThinkingDisableIfNeeded(payload) {
  if (!isThinkingDisableEnabled()) return payload;
  const model = payload?.model;
  if (typeof model !== 'string' || !QWEN_MODEL_PATTERN.test(model)) return payload;
  // Caller-provided value wins (явный opt-in/out для конкретного вызова).
  if (payload.enable_thinking !== undefined) return payload;
  payload.enable_thinking = false;
  return payload;
}

/**
 * Классификация HTTP-статуса ответа RouterAI.
 * 429 (rate limit) и 5xx (server errors) retry'ятся — это transient-сбои.
 * 4xx кроме 429 НЕ retry'ятся (клиентская/авторизационная ошибка — чинит Dev-A).
 */
export function isRetryableStatus(status) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Классификация сетевой ошибки: стоит ли ретраить.
 * `fetch failed` чаще всего = битый keep-alive коннект; новый fetch с новым
 * AbortController/signal поднимает свежее соединение.
 */
const RETRYABLE_NETWORK_ERRORS = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|AbortError|network|terminated/i;

export function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const message = err.message || String(err);
  return RETRYABLE_NETWORK_ERRORS.test(message);
}

/**
 * Exponential backoff с джиттером.
 * База 1000ms × 2^attempt, cap 30s, плюс случайный джиттер 0–1000ms,
 * чтобы при массовом ретрае не было thundering herd.
 */
function computeBackoffDelay(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  const jitter = Math.random() * 1000;
  return Math.round(base + jitter);
}

/**
 * Читает SSE-поток ответа RouterAI и собирает из дельт единый ответ в том же
 * формате, что и non-streaming: `{ id, model, choices:[{index,message:{role,
 * content, reasoning_content?},finish_reason}], usage }`.
 *
 * Поддерживает оба варианта поля reasoning у DeepSeek-совместимых провайдеров:
 * `delta.reasoning_content` (OpenAI-style) и `delta.reasoning` (DeepSeek-native).
 */
export async function consumeSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let finishReason = null;
  let usage = null;
  let model = null;
  let id = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE: значимые строки начинаются с "data: "
    const lines = buffer.split('\n');
    buffer = lines.pop(); // последняя, возможно неполная строка
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        if (!id && chunk.id) id = chunk.id;
        if (!model && chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
        if (choice?.delta?.reasoning) reasoningContent += choice.delta.reasoning;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      } catch {
        /* skip malformed chunk */
      }
    }
  }

  return {
    id,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * @param {object} payload — тело запроса (model/messages/…).
 * @param {object} [options] — W4.7: пер-call override бюджета (аддитивно,
 *   для служебных one-shot вызовов — FAQ-генератор и т.п.).
 *   Роли пайплайна НЕ передают — живут на env-политике W1.5.
 * @param {number} [options.maxRetries] — ретраи сверх первой попытки
 *   (0 = одна попытка); по умолчанию env ROUTERAI_MAX_RETRIES (2).
 * @param {number} [options.timeoutMs] — per-attempt таймаут; по умолчанию
 *   env ROUTERAI_TIMEOUT_MS (180с).
 */
export async function callRouterAI(payload, { maxRetries: retriesOverride, timeoutMs: timeoutOverride } = {}) {
  // M3: активный провайдер (ProviderConfig → env-fallback). Резолюция не
  // бросает; guard ниже сохраняет честный fail-fast GeneRaptor по отсутствию
  // ключа (для keyless-провайдеров ключ не требуется).
  const provider = await resolveActiveProviderForEngine();
  if (!provider.apiKey && !provider.keyOptional) {
    throw missingProviderKeyError(provider);
  }

  // W1.5 (2026-08-17, калибровка по прод-данным аналитика, 97 ранов): попыток
  // 5 → 3 (1 initial + 2 retries). Фактчекер (qwen3.7-plus + thinking, ~16k
  // in-токенов) исчерпывал все 5 попыток в 43% ранов → 932с чистого ожидания
  // на одну роль → fallback-финализация без фактчек-прохода. Трёх попыток
  // достаточно: успешные прогоны ролей укладываются в 143–539с ЗА ВСЮ роль
  // (с внутренними ретраями), т.е. per-attempt таймаут 180с ниже НЕ трогаем.
  // Kill-switch: ROUTERAI_MAX_RETRIES в env возвращает прежнее число попыток
  // (читается на каждый вызов, не при import).
  // W4.7: per-call override (retriesOverride/timeoutOverride) бьёт env —
  // служебным one-shot вызовам нельзя ждать 3×180с (находка Dev-B: задержка
  // старта генерации 4–9 мин на деградированном RouterAI).
  // TL-ревью W1: Number('мусор') = NaN — без guard'а цикл попыток вообще не
  // выполнялся бы и callRouterAI делал `throw undefined`; лечим фолбэком на
  // дефолт (то же для таймаута: Math.max(x, NaN) = NaN → мгновенный abort).
  // FIX-F2 (QA): пустая строка env (ROUTERAI_MAX_RETRIES=) тоже дефолт —
  // Number('') === 0 давало бы 0 ретраев/мгновенный 1с-таймаут.
  const retriesRaw = retriesOverride ?? resolveEnvNumber(process.env.ROUTERAI_MAX_RETRIES, 2);
  const maxRetries = Number.isFinite(retriesRaw) ? Math.max(0, Math.floor(retriesRaw)) : 2;
  const maxAttempts = maxRetries + 1;
  const timeoutRaw = timeoutOverride ?? resolveEnvNumber(process.env.ROUTERAI_TIMEOUT_MS, 180_000);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(1_000, timeoutRaw) : 180_000;
  // W1.5: скользящий бюджет на вызов роли — суммарное ожидание (попытки +
  // backoff-сны) не превысит maxAttempts × timeoutMs. При исчерпании до старта
  // очередной попытки — быстрый fail с последней ошибкой: даже при завышенном
  // ROUTERAI_MAX_RETRIES и ливне коротких сбоев роль не висит 15.5 минут.
  const roleBudgetMs = maxAttempts * timeoutMs;
  const callStart = Date.now();
  let lastError;

  // STREAMING-OVERRIDE-FLAG
  // Каждая попытка может переключать режим: если streaming упал на сетевой
  // ошибке, следующая попытка пробует non-streaming (вдруг разовый сбой), и
  // наоборот. Это даёт максимальную отказоустойчивость.
  let streamMode = ROUTERAI_STREAM_ENABLED && payload.stream !== false;
  // Позволяем конкретному вызову явно запросить non-streaming через payload.
  if (payload.stream === true) streamMode = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // W1.5: скользящий бюджет — перед СТАРТОМ очередной попытки убеждаемся,
    // что роль ещё вписывается в maxAttempts × timeoutMs. Исчерпан → быстрый
    // fail (break → throw lastError / возврат ответа). Успешный медленный
    // вызов не страдает: он завершается в пределах своего per-attempt
    // таймаута и до этого чека не доходит.
    if (attempt > 1 && Date.now() - callStart >= roleBudgetMs) {
      console.error(
        `[callRouterAI] Скользящий бюджет роли исчерпан (${Date.now() - callStart}ms ≥ ${roleBudgetMs}ms) — быстрый fail без попытки ${attempt}/${maxAttempts}.`
      );
      break;
    }

    // Свежее соединение на КАЖДУЮ попытку: новый AbortController + новый signal.
    // Старый keep-alive коннект мог быть закрыт сервером → `fetch failed`.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const requestStart = Date.now();
    try {
      // Клонируем payload и выставляем stream-флаги для текущего режима.
      const requestPayload = { ...payload };
      if (streamMode) {
        requestPayload.stream = true;
        // Запрашиваем usage в финальном чанке (OpenAI/DeepSeek-совместимо).
        requestPayload.stream_options = { ...(requestPayload.stream_options || {}), include_usage: true };
      } else {
        delete requestPayload.stream;
        delete requestPayload.stream_options;
      }
      // gate-2026-08-10 ФИКС #1: отключаем reasoning для qwen-моделей.
      applyThinkingDisableIfNeeded(requestPayload);
      const body = JSON.stringify(requestPayload);
      console.error(
        `[callRouterAI] Попытка ${attempt}/${maxAttempts} · payload ${body.length} bytes · model: ${requestPayload.model} · stream: ${streamMode}`
      );
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });

      let data;
      if (streamMode && response.ok && response.body) {
        // Streaming-путь: читаем SSE-чанки, собираем content/usage/finish.
        data = await consumeSSEStream(response);
      } else {
        const text = await response.text();
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
      }

      // HTTP-level retry: 429 (rate limit) и 5xx — transient-сбои провайдера.
      // 4xx кроме 429 — НЕ ретраим (клиентская/авторизационная ошибка).
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        // FIX-M1 (2026-08-17): эта ветка — единственный retry-путь без throw,
        // поэтому lastError обязан писаться ЗДЕСЬ: если после серии 429/5xx
        // скользящий бюджет оборвёт цикл (break), финальный throw должен
        // нести осмысленную ошибку, а не undefined.
        lastError = new Error(
          `RouterAI HTTP ${response.status}: попытка ${attempt}/${maxAttempts} не удалась (retryable)`
        );
        console.error(
          `[callRouterAI] Попытка ${attempt} не удалась: HTTP ${response.status}. Retry через ${delay}ms`
        );
        // Меняем режим при retry: устойчивость к багам одного из путей.
        streamMode = !streamMode && ROUTERAI_STREAM_ENABLED;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (streamMode) {
        const c = data?.choices?.[0]?.message?.content ?? '';
        const r = data?.choices?.[0]?.message?.reasoning_content ?? '';
        const ct = data?.usage?.completion_tokens ?? '?';
        console.error(
          `[callRouterAI] Поток завершён · got ${ct} tokens (content: ${c.length} chars, reasoning: ${r.length} chars) · elapsed: ${Date.now() - requestStart}ms · finish: ${data?.choices?.[0]?.finish_reason ?? '?'}`
        );
      }

      return { status: response.status, data };
    } catch (err) {
      lastError = err;
      const reason =
        err.name === 'AbortError' || err.message?.includes('AbortError')
          ? `timeout (AbortError): ${err.message}`
          : err.message || String(err);

      // Сетевые ошибки ретраим; прочие — пробрасываем сразу.
      if (!isRetryableNetworkError(err)) {
        console.error(`[callRouterAI] Попытка ${attempt} не удалась: ${reason}. Без retry (не сетевая).`);
        throw err;
      }

      if (attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        // При сетевом сбое переключаем режим: если streaming упал — пробуем
        // non-streaming, и наоборот. Streaming обычно устойчивее к 60с-таймауту,
        // но если упал он, запасной путь может спасти.
        streamMode = !streamMode && ROUTERAI_STREAM_ENABLED;
        console.error(
          `[callRouterAI] Попытка ${attempt} не удалась: ${reason}. Retry через ${delay}ms (режим: stream=${streamMode})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error(`[callRouterAI] Попытка ${attempt} не удалась: ${reason}. Попытки исчерпаны.`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // FIX-M1: гарантированный Error даже если цикл оборван бюджетом до того,
  // как какая-либо ветка успела записать lastError.
  throw lastError ?? new Error('RouterAI: бюджет ретраев исчерпан без ответа (retry budget exhausted)');
}

/* ------------------------------------------------------------------ */
/*  W4.1 (2026-08-17): цепочка резервных моделей RouterAI              */
/* ------------------------------------------------------------------ */

// Прод-факт (3 деплоя подряд: 20260816, W1, W2): финальные
// роли конвейера падают по «This operation was aborted» ПОСЛЕ исчерпания всех
// попыток callRouterAI — стабильная деградация конкретной модели RouterAI, а
// не разовый сбой. Исправление (W4.1, решение D4 владельца): ТОЧЕЧНАЯ
// деградация модели роли по tier-цепочке, включаемая ТОЛЬКО на повторном сбое
// (когда звено исчерпало собственные ретраи W1.5):
//   critical   → generation (qwen3.6-flash) → STOP (deepseek НЕ для крит-ролей:
//                фактчек/QC/семантика — риск R4, урок thinking-off→topicRu);
//   generation → standard (deepseek-v4-flash) → STOP;
//   standard   → STOP.
// Инварианты:
//   - первичная модель ВСЕГДА первая (никаких превентивных переключений);
//   - payload клонируется с заменой ТОЛЬКО model: thinking-флаги
//     (NO_THINKING_ROLES → enable_thinking:false) и max_tokens роли
//     сохраняются на любом звене;
//   - kill-switch: ROUTERAI_FALLBACK_CHAIN=off — полное отключение (default ON);
//   - каждая деградация логируется WARN'ом; реально исполнившая модель
//     возвращается воркеру через chainInfo → AgentRun.outputJson.model.

export function isFallbackChainEnabled() {
  // Default ON; env читается на каждый вызов (не при import) — тесты/hot-reload.
  return String(process.env.ROUTERAI_FALLBACK_CHAIN ?? 'on').toLowerCase() !== 'off';
}

/**
 * W4.1: модели цепочки деградации для роли (БЕЗ первичной модели).
 * @param {string} roleId
 * @param {{generationModel?: string, standardModel?: string}} [models] — override
 *        (по умолчанию env-резолв DEFAULT_GENERATION_MODEL/DEFAULT_STANDARD_MODEL)
 * @returns {string[]}
 */
export function resolveFallbackChainModels(roleId, { generationModel, standardModel } = {}) {
  if (!isFallbackChainEnabled()) return [];
  let tier = null;
  try {
    tier = getExecutableRole(roleId).modelTier;
  } catch {
    return []; // неизвестная роль — без цепочки (defensive)
  }
  if (tier === 'critical' || tier === 'hard') {
    return [asNonEmptyString(generationModel, DEFAULT_GENERATION_MODEL)];
  }
  if (tier === 'generation') {
    return [asNonEmptyString(standardModel, DEFAULT_STANDARD_MODEL)];
  }
  return []; // standard → STOP
}

/** W4.1: 2xx-ответ содержит содержательный content (критерий успеха роли). */
function responseHasMeaningfulContent(response) {
  const choice = extractFirstChoice(response);
  const message = choice?.message ?? choice;
  const content =
    extractTextFromMessage(message) ||
    (typeof choice?.text === 'string' ? choice.text : '') ||
    (typeof response?.output_text === 'string' ? response.output_text : '') ||
    (typeof response?.text === 'string' ? response.text : '') ||
    '';
  return Boolean(content.trim());
}

/**
 * W4.1: вызов роли с цепочкой резервных моделей.
 *
 * Контракт возврата идентичен callRouterAI — result `{ status, data }` ИЛИ
 * throw последней ошибки, — чтобы существующие fallback-пути воркера (шаблон
 * автора, finalizeWithFallback, unrecoverable) работали без изменений: цепочка
 * исчерпана → поведение ровно как до W4.1 (последний результат/ошибка).
 *
 * Каждое звено получает полный бюджет ретраев callRouterAI (W1.5: 3 попытки,
 * скользящий бюджет): деградация включается ТОЛЬКО когда звено его исчерпало
 * (throw / non-2xx / 2xx без контента). Auth-статусы (401/402/403) цепочку
 * обрывают сразу — смена модели битый ключ/баланс не лечит; результат
 * возвращается как есть (воркер разрулит unrecoverable, как до W4.1).
 *
 * @param {object} payload — payload роли (model = первичная модель тира)
 * @param {object} [opts]
 * @param {string} opts.roleId — для tier-резолва цепочки
 * @param {string} [opts.generationModel] — override (env-резолв по умолчанию)
 * @param {string} [opts.standardModel]
 * @param {object} [opts.chainInfo] — out-параметр:
 *   { model — последняя модель, к которой уходил вызов (на успехе — реально
 *     исполнившая роль); fallbackModel — модель деградации, УСПЕШНО
 *     исполнившая роль (FIX-F1: null, если справилась первичная ИЛИ цепочка
 *     исчерпана — упавшая модель не считается fallback'ом, иначе мониторинг
 *     по [gen-digest] читал «failed + fallbackModel:deepseek» как деградацию,
 *     хотя роль никто не исполнил); failedAttempts — сколько деградаций
 *     цепочки произошло до успеха/исчерпания (0 = первичная сама справилась) }
 * @returns {Promise<{status: number, data: object}>}
 */
export async function callRouterAIWithFallbackChain(payload, { roleId, generationModel, standardModel, chainInfo } = {}) {
  // M3: тир-назначения активного провайдера бьют env-модели
  // caller'а — применяются ЗДЕСЬ, чтобы воркер и его константы не менялись.
  // Неназначенные тиры остаются на разрешении caller/env (поведение прежней конфигурации).
  const provider = await resolveActiveProviderForEngine();
  const providerModels = provider?.models || {};
  let tier = null;
  try {
    tier = getExecutableRole(roleId).modelTier;
  } catch {
    tier = null; // неизвестная роль — без переназначения (defensive)
  }
  const pinnedPrimary = pinnedTierModel(tier, providerModels);
  const primaryModel = pinnedPrimary || payload?.model;
  // Payload с переназначенной первичной моделью (M3): клонируем, меняя ТОЛЬКО
  // model — thinking-флаги/max_tokens роли сохраняются (инвариант W4.1).
  const effectivePayload = pinnedPrimary && payload ? { ...payload, model: pinnedPrimary } : payload;
  const fallbackModels = resolveFallbackChainModels(roleId, {
    generationModel: providerModels.generation ?? generationModel,
    standardModel: providerModels.standard ?? standardModel,
  })
    .filter((model) => model && model !== primaryModel);
  const models = [primaryModel, ...fallbackModels];

  let lastError;
  let lastResult;
  let lastLink = 0;

  for (let link = 0; link < models.length; link++) {
    const model = models[link];
    lastLink = link;
    // Клонируем payload, меняя ТОЛЬКО model: enable_thinking (NO_THINKING_ROLES),
    // max_tokens и прочие флаги роли сохраняются на любом звене.
    const attemptPayload = model === primaryModel ? effectivePayload : { ...payload, model };
    try {
      const result = await callRouterAI(attemptPayload);
      lastResult = result;
      lastError = undefined;

      // Auth/quota — смена модели не поможет; выходим с этим результатом.
      if (result?.status === 401 || result?.status === 402 || result?.status === 403) {
        break;
      }

      if (result?.status >= 200 && result?.status < 300 && responseHasMeaningfulContent(result.data)) {
        if (chainInfo) {
          chainInfo.model = model;
          chainInfo.fallbackModel = link > 0 ? model : null;
          chainInfo.failedAttempts = link;
        }
        return result;
      }

      const reason = result?.status >= 200 && result?.status < 300
        ? `HTTP ${result.status} — модель не вернула содержательный ответ`
        : `HTTP ${result?.status}`;
      if (link + 1 < models.length) {
        console.warn(
          `[model-chain] Роль «${roleId}»: модель ${model} не дала ответа (${reason}) — деградация на ${models[link + 1]} (звено ${link + 2}/${models.length}).`
        );
      }
    } catch (err) {
      lastError = err;
      lastResult = undefined;
      if (link + 1 < models.length) {
        console.warn(
          `[model-chain] Роль «${roleId}»: модель ${model} упала (${err?.message || err}) — деградация на ${models[link + 1]} (звено ${link + 2}/${models.length}).`
        );
      }
    }
  }

  // Цепочка исчерпана (либо single-model режим: off/standard-тир) — СТАРОЕ
  // поведение: последний результат возвращаем, иначе бросаем последнюю ошибку.
  // FIX-F1 (QA): fallbackModel здесь ВСЕГДА null — модель деградации «считается»
  // только когда она УСПЕШНО исполнила роль; исчерпание = роль никто не исполнил
  // (раньше писалась последняя упавшая модель — «failed + fallbackModel:…»
  // вводило мониторинг в заблуждение). model — последняя попытка (для журнала).
  if (chainInfo) {
    chainInfo.model = models[lastLink] ?? primaryModel;
    chainInfo.fallbackModel = null;
    chainInfo.failedAttempts = lastLink;
  }
  if (lastResult) return lastResult;
  throw lastError ?? new Error(`RouterAI: цепочка моделей исчерпана без ответа (роль «${roleId}»)`);
}
