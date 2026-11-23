/**
 * Cover generation service (see docs/architecture.md §7 «Обложки») — the single
 * entry point behind
 * POST /api/articles/:id/cover.
 *
 * Flow (mirrors steps 1–14):
 *   validate input → load the full article row → in-flight guard →
 *   feature guard (settings + images-capable provider) → content guard
 *   (newest base version) → budget gate BEFORE any spend → compress the
 *   article via callRouterAI → compose the image prompt → generate the image
 *   (routerai-images) → store the binary in the LOCAL cover store →
 *   atomically update the six cover* columns + the cover phase channel
 *   (D8: never status) →
 *   write the ledger row (agentRun «Генерация обложки»).
 *
 * M5: WordPress left the cover flow. The binary is a file
 * under <data-dir>/covers/ and the database keeps the file reference; the
 * bytes are served by GET /api/articles/:id/cover. The cover
 * flow works with ZERO WordPress env vars.
 *
 * Money semantics (R9): the ledger row is created even when the flow fails
 * AFTER the image call — the provider may have charged us. A compression
 * failure happens before any spend, so it writes no ledger row.
 *
 * All errors surface as CoverFlowError with the frozen machine codes and the
 * RU messages; the route only maps them onto the response.
 */

import { prisma } from '../db.mjs';
import { callRouterAI } from '../agent-role-execution.mjs';
import { isValidUUID } from './validation.mjs';
import { htmlToPlainText } from './markdown-renderer.mjs';
// M5: the cover binary lives in the LOCAL store — the
// WordPress media library left the cover flow.
import { saveCoverBinary } from './cover-store.mjs';
// M5 (D9): only images-capable providers may produce covers. The provider
// layer (M3) is consumed as-is — endpoint + key come from the provider.
import { resolveCoverProvider, resolveActiveProvider } from './providers.mjs';
import { getCoverSettings } from './cover-settings.mjs';
import { buildCoverPrompt, buildCompressionRequest } from './cover-prompt.mjs';
import { generateImage, CoverImageError } from './routerai-images.mjs';
import {
  COVER_AGENT_NAME,
  spentThisMonthRub,
  estimateImageCostRub,
  isBudgetExceeded,
} from './cover-pricing.mjs';

export { COVER_AGENT_NAME };

// ── Tunables ────────────────────────────────────────────────────────────────
const MAX_REFINEMENT_LEN = 500;
const COMPRESSION_SOURCE_LIMIT = 12000;
const COMPRESSION_MAX_RETRIES = 1;
const COMPRESSION_TIMEOUT_MS = 60_000;
const COMPRESSION_TEMPERATURE = 0.3;
const COMPRESSION_MAX_TOKENS = 1200;
const PROMPT_PREVIEW_LEN = 300;

// ── Frozen machine codes + RU messages ──────────────────────────────────────
const COVER_ERRORS = Object.freeze({
  cover_invalid_article_id: { status: 400, message: 'Некорректный идентификатор статьи.' },
  cover_invalid_refinement: { status: 400, message: 'Уточнение слишком длинное (до 500 символов).' },
  cover_empty_article: { status: 400, message: 'Сначала сгенерируйте текст статьи — обложка строится по нему.' },
  cover_budget_exceeded: { status: 402, message: 'Лимит на генерацию обложек в этом месяце исчерпан. Обложка не изменена.' },
  cover_disabled: { status: 403, message: 'Генерация обложек отключена в настройках.' },
  cover_article_not_found: { status: 404, message: 'Статья не найдена.' },
  cover_in_progress: { status: 409, message: 'Обложка уже генерируется — дождитесь окончания.' },
  cover_generation_failed: { status: 502, message: 'Не удалось получить изображение у модели. Попробуйте ещё раз.' },
  cover_compression_failed: { status: 502, message: 'Не удалось сжать статью для генерации обложки.' },
  cover_save_failed: { status: 500, message: 'Не удалось сохранить обложку на диск.' },
  cover_not_configured: { status: 503, message: 'Провайдер изображений не настроен.' },
  // D9: the active provider is configured, but it cannot generate images.
  cover_provider_images_unsupported: { status: 503, message: 'Активный провайдер не поддерживает генерацию изображений.' },
});

/** Typed flow error: the route maps code/status/message onto the response. */
export class CoverFlowError extends Error {
  constructor(code, message) {
    const known = COVER_ERRORS[code];
    super(message || known?.message || code);
    this.name = 'CoverFlowError';
    this.code = code;
    this.status = known?.status ?? 500;
  }
}

// One concurrent generation per article; released in finally.
const coverInFlight = new Set();

/* ── Post-finalize hook (checkbox wave) ──────────────────────────────────────
 *
 * maybeGenerateCover is the ONLY writer of Article.coverRequested /
 * coverStatus / coverSkipReason (the /start idempotency branch excepted).
 * The worker fires it WITHOUT await after the article reached its terminal
 * status (Director resolution Q3: non-blocking, worker slot freed
 * immediately) — cover progress travels on the per-article coverStatus
 * channel and the UI polls GET /:id/content.
 *
 * The cover phase NEVER writes Article.status (D8): budget/skip/fail on a
 * checkbox-requested cover leaves the article exactly as finalization made it.
 */

/**
 * Skip = we decided NOT to spend. Fail = we tried (maybe spent) and broke.
 *
 * Список skip-кодов (потратить решили НЕ): они заданы здесь, потому что
 * решение «не тратить» принимается в нескольких местах. Fail-коды
 * (cover_generation_failed / cover_compression_failed / cover_save_failed /
 * cover_in_progress) перечислять отдельно не нужно: они рождаются на месте
 * и описаны в COVER_ERRORS выше — дубль списка никто не читал.
 *
 * В этом модуле источников кодов два: COVER_ERRORS (все коды + status +
 * RU message) и COVER_SKIP_CODES (этот skip-список: cover_not_configured,
 * cover_provider_images_unsupported, cover_article_not_found,
 * cover_invalid_article_id).
 */
export const COVER_SKIP_CODES = Object.freeze([
  'cover_budget_exceeded',
  'cover_disabled',
  'cover_not_configured',
  // D9 (M5): the provider cannot produce images — decided BEFORE any spend.
  'cover_provider_images_unsupported',
  'cover_empty_article',
  'cover_article_not_found',
  'cover_invalid_article_id',
  'cover_exists',
  // W «automation-live» (2026-10-28, D3): the service is listed in
  // the service-level cover disable — decided BEFORE any spend.
  'cover_disabled_for_service',
]);

/**
 * Post-finalize cover phase. Fire-and-forget from the worker's finalize paths.
 * @param {string} articleId
 * @returns {Promise<void>} resolves when the phase reached a terminal state
 *   (or decided not to run); never throws on flow failures — they land in
 *   coverStatus/coverSkipReason (design NFR: the reason is visible in the DB,
 *   not only in logs).
 */
export async function maybeGenerateCover(articleId) {
  // a. Read the request flag + the existing cover.
  //    M5 unhooked the WordPress service — the Article model has no `serviceId`
  //    any more, and Prisma validates a select against the LIVE schema: a stale
  //    field here throws PrismaClientValidationError before the flow starts,
  //    so the automatic cover never ran at all.
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, coverRequested: true, coverUrl: true },
  });
  if (!article) return;

  // b. The launch condition — CREATED in this wave:
  //    the global settings.autoGenerate had NO runtime consumer before.
  //    A settings-read failure degrades to autoGenerate:false; a REQUESTED
  //    cover must not be lost to a settings hiccup (the flow re-reads
  //    settings itself and would skip with its own machine code if needed).
  let autoGenerate = false;
  try {
    const settings = await getCoverSettings();
    autoGenerate = settings.autoGenerate === true;
  } catch (err) {
    console.warn(
      `[cover-service] maybeGenerateCover: settings read failed (autoGenerate defaults false): ${err?.message || err}`,
    );
  }
  if (!(autoGenerate || article.coverRequested === true)) return;

  // c. Idempotency: a cover already bound → consume the request as skipped.
  if (article.coverUrl) {
    await prisma.article.update({
      where: { id: articleId },
      data: { coverRequested: false, coverStatus: 'skipped', coverSkipReason: 'cover_exists' },
    });
    return;
  }

  // c2. M2: the per-service negative cover list is removed with the
  // topic-picking settings tree (services themselves are gone with crawl).
  // Covers stay ON for every article — the previous read-failure default.

  // d. Mark the phase BEFORE running (the UI spinner rides this write).
  await prisma.article.update({
    where: { id: articleId },
    data: { coverStatus: 'generating', coverSkipReason: null },
  });

  // e. Run the existing flow; map its machine code onto skipped/failed.
  try {
    await generateCoverForArticle({ articleId });
    await prisma.article.update({
      where: { id: articleId },
      data: { coverStatus: 'ready', coverSkipReason: null, coverRequested: false },
    });
  } catch (err) {
    const code = typeof err?.code === 'string' && err.code !== ''
      ? err.code
      : 'cover_generation_failed';
    const coverStatus = COVER_SKIP_CODES.includes(code) ? 'skipped' : 'failed';
    console.warn('[Cover] post-finalize failed', { articleId, code });
    await prisma.article.update({
      where: { id: articleId },
      data: { coverStatus, coverSkipReason: code, coverRequested: false },
    });
  }
  // f. coverRequested consumed in ANY terminal outcome (written above) —
  //    no auto-retry, no double spend; the manual panel button stays.
}

/**
 * Generate (or regenerate) the cover for one article.
 * @param {{ articleId: string, refinement?: string|null, fresh?: boolean }} args
 * @returns {Promise<{ coverUrl: string, coverFile: string, model: string,
 *   costRub: number, spentThisMonthRub: number, monthlyCapRub: number,
 *   promptPreview: string, warnings: string[] }>}
 */
export async function generateCoverForArticle({ articleId, refinement, fresh } = {}) {
  // Steps 0–1: cheap validation before any DB work.
  if (typeof articleId !== 'string' || !isValidUUID(articleId)) {
    throw new CoverFlowError('cover_invalid_article_id');
  }
  const effectiveRefinement = resolveRefinement(refinement, fresh);

  // Step 2: load the full article row (no select — the flow reads several fields).
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) {
    throw new CoverFlowError('cover_article_not_found');
  }

  // Step 3: in-flight guard.
  if (coverInFlight.has(article.id)) {
    throw new CoverFlowError('cover_in_progress');
  }
  coverInFlight.add(article.id);
  try {
    return await runCoverGeneration({ article, refinement: effectiveRefinement });
  } finally {
    coverInFlight.delete(article.id);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Cover availability (D9): the covers are available when the settings are
 * enabled AND the active provider can generate images. WordPress is NOT part
 * of the equation anymore (M5 — the binary lives in the local store).
 *
 * The reason is a machine code the UI maps to a human sentence:
 *   - `cover_disabled` — the settings switch is off;
 *   - `cover_not_configured` — no provider is configured at all;
 *   - `cover_provider_images_unsupported` — a provider is active but it
 *     cannot generate images.
 *
 * @returns {Promise<{ available: boolean, reason: string|null, providerKind: string|null }>}
 */
export async function resolveCoverAvailability() {
  let settings;
  try {
    settings = await getCoverSettings();
  } catch (err) {
    console.warn('[cover-service] cover settings unavailable:', err?.message || err);
    settings = { enabled: false };
  }
  if (!settings.enabled) {
    return { available: false, reason: 'cover_disabled', providerKind: null };
  }

  let provider = null;
  try {
    provider = await resolveCoverProvider();
  } catch (err) {
    console.error('[cover-service] provider resolution failed:', err?.message || err);
    provider = null;
  }
  if (provider?.ok) {
    return { available: true, reason: null, providerKind: provider.kind };
  }

  const active = await resolveActiveProvider().catch(() => null);
  return {
    available: false,
    reason: active ? 'cover_provider_images_unsupported' : 'cover_not_configured',
    providerKind: active?.kind ?? null,
  };
}

/** R4: fresh regeneration ignores refinements; '' counts as "no refinement". */
function resolveRefinement(refinement, fresh) {
  if (fresh === true) return null;
  if (refinement === undefined || refinement === null) return null;
  if (typeof refinement !== 'string') {
    throw new CoverFlowError('cover_invalid_refinement');
  }
  const trimmed = refinement.trim();
  if (trimmed.length > MAX_REFINEMENT_LEN) {
    throw new CoverFlowError('cover_invalid_refinement');
  }
  return trimmed === '' ? null : trimmed;
}

async function runCoverGeneration({ article, refinement }) {
  // Step 4: feature guard — settings + the images capability of the active
  // provider (D9). WordPress is NOT part of the cover flow anymore (M5):
  // the gate is "the active provider can generate images".
  const settings = await getCoverSettings();
  if (!settings.enabled) {
    throw new CoverFlowError('cover_disabled');
  }
  let provider = null;
  try {
    provider = await resolveCoverProvider();
  } catch (err) {
    // The provider layer must never break the cover flow with a generic 500:
    // a broken lookup degrades to "no provider resolved" (503 + a code).
    console.error('[cover-service] provider resolution failed:', err?.message || err);
    provider = null;
  }
  if (!provider || !provider.ok) {
    // Nothing configured at all → an honest "not configured" code; a
    // configured but images-incapable provider → the capability code (D9),
    // so the UI can explain WHY the cover is unavailable.
    const active = await resolveActiveProvider().catch(() => null);
    if (!active) {
      throw new CoverFlowError('cover_not_configured');
    }
    throw new CoverFlowError('cover_provider_images_unsupported');
  }

  // Step 5: content guard — newest base version.
  const latestVersion = await prisma.articleVersion.findFirst({
    where: { articleId: article.id, platform: 'base' },
    orderBy: { createdAt: 'desc' },
  });
  const sourceText = extractSourceText(latestVersion);
  if (!sourceText) {
    throw new CoverFlowError('cover_empty_article');
  }

  // Step 7: budget gate BEFORE any spend (compression included).
  const now = new Date();
  const spentRub = await spentThisMonthRub(now);
  const capRub = settings.monthlyCapRub;
  const estimateRub = estimateImageCostRub(settings.model, settings.resolution);
  if (isBudgetExceeded({ spentRub, capRub, estimateRub })) {
    throw new CoverFlowError('cover_budget_exceeded');
  }

  // Step 8: compression — before the ledger clock, no money spent yet.
  const runStartedAt = new Date();
  const compression = await compressArticle({
    title: article.topic,
    text: sourceText,
    model: settings.compressionModel,
  });

  // Step 9: prompt composition.
  const composedPrompt = buildCoverPrompt({
    template: settings.promptTemplate,
    brief: compression.brief,
    refinement,
    title: article.topic,
  });

  // Step 10: image generation — money is spent from here on.
  const imageStartedAt = Date.now();
  let image;
  try {
    image = await generateImage({
      model: settings.model,
      prompt: composedPrompt,
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      quality: settings.quality,
      outputFormat: settings.outputFormat,
      // M5: endpoint + key come from the provider config.
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
  } catch (err) {
    await recordFailedRun({
      articleId: article.id,
      settings,
      composedPrompt,
      refinement,
      provider,
      runStartedAt,
      imageCostRub: 0,
      compressionCostRub: compression.costRub,
      errorCode: err instanceof CoverImageError ? err.code : 'cover_generation_failed',
      errorMessage: err.message,
    });
    const code = err instanceof CoverImageError && err.code === 'cover_not_configured'
      ? 'cover_not_configured'
      : 'cover_generation_failed';
    throw new CoverFlowError(code);
  }
  const durationMs = Date.now() - imageStartedAt;

  // Step 11: store the binary in the LOCAL cover store — a write
  // failure means nothing is bound to the article.
  const ext = settings.outputFormat || 'png';
  let stored;
  try {
    stored = saveCoverBinary({
      articleId: article.id,
      buffer: image.buffer,
      ext,
    });
  } catch (err) {
    await recordFailedRun({
      articleId: article.id,
      settings,
      composedPrompt,
      refinement,
      provider,
      runStartedAt,
      imageCostRub: image.costRub,
      compressionCostRub: compression.costRub,
      bytes: image.buffer.length,
      errorCode: 'cover_save_failed',
      errorMessage: err.message,
    });
    throw new CoverFlowError('cover_save_failed');
  }

  // Step 12: no WordPress binding anymore (M5) — nothing to warn about.
  const warnings = [];

  // Step 13: bind the cover — the six cover fields + the phase channel, never
  // Article.status (D8). The channel travels with the binary: a manual
  // generation that never writes coverStatus leaves a previously failed cover
  // in the failure state and the panel never shows the new cover.
  const coverGeneratedAt = new Date();
  await prisma.article.update({
    where: { id: article.id },
    data: {
      coverUrl: stored.route,
      coverFile: stored.filename,
      coverModel: settings.model,
      coverPrompt: composedPrompt,
      coverCostRub: image.costRub,
      coverGeneratedAt,
      coverStatus: 'ready',
      coverSkipReason: null,
    },
  });

  // Step 14: ledger row for the successful run.
  await prisma.agentRun.create({
    data: {
      articleId: article.id,
      agentName: COVER_AGENT_NAME,
      status: 'success',
      inputJson: JSON.stringify(buildInputJson({ settings, composedPrompt, refinement, provider })),
      outputJson: JSON.stringify({
        coverUrl: stored.route,
        coverFile: stored.filename,
        bytes: image.buffer.length,
        durationMs,
        generatedAt: coverGeneratedAt.toISOString(),
        compressionCostRub: compression.costRub,
      }),
      costRub: image.costRub,
      startedAt: runStartedAt,
      finishedAt: new Date(),
    },
  });

  return {
    coverUrl: stored.route,
    coverFile: stored.filename,
    model: settings.model,
    costRub: image.costRub,
    spentThisMonthRub: spentRub + image.costRub,
    monthlyCapRub: capRub,
    promptPreview: composedPrompt.slice(0, PROMPT_PREVIEW_LEN),
    warnings,
  };
}

/** contentText wins; otherwise strip HTML; blank → '' (→ cover_empty_article). */
function extractSourceText(version) {
  if (!version) return '';
  const hasText = typeof version.contentText === 'string' && version.contentText.trim() !== '';
  const raw = hasText ? version.contentText : htmlToPlainText(version.contentHtml ?? '');
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text.length > COMPRESSION_SOURCE_LIMIT ? text.slice(0, COMPRESSION_SOURCE_LIMIT) : text;
}

/**
 * Compress the article into a short banner brief.
 * Any malformed/empty result is a hard cover_compression_failed — no image
 * call, no article write, no ledger row (no money was spent yet).
 */
async function compressArticle({ title, text, model }) {
  const { system, user } = buildCompressionRequest({ title, text });
  let response;
  try {
    response = await callRouterAI(
      {
        model,
        temperature: COMPRESSION_TEMPERATURE,
        max_tokens: COMPRESSION_MAX_TOKENS,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      { maxRetries: COMPRESSION_MAX_RETRIES, timeoutMs: COMPRESSION_TIMEOUT_MS },
    );
  } catch (err) {
    console.warn(`[cover-service] compression request failed: ${err.message}`);
    throw new CoverFlowError('cover_compression_failed');
  }
  if (!response || response.status !== 200) {
    throw new CoverFlowError('cover_compression_failed');
  }
  const brief = String(response.data?.choices?.[0]?.message?.content ?? '').trim();
  if (!brief) {
    throw new CoverFlowError('cover_compression_failed');
  }
  const cost = Number(response.data?.usage?.cost);
  return { brief, costRub: Number.isFinite(cost) ? cost : null };
}

function buildInputJson({ settings, composedPrompt, refinement, provider }) {
  return {
    prompt: composedPrompt,
    model: settings.model,
    provider: provider?.kind || 'routerai',
    resolution: settings.resolution,
    aspectRatio: settings.aspectRatio,
    quality: settings.quality,
    outputFormat: settings.outputFormat,
    ...(refinement ? { refinement } : {}),
  };
}

/**
 * Failure AFTER the image call: still record the ledger row — the money was
 * spent (R9). A ledger write failure must never mask the primary error.
 */
async function recordFailedRun({
  articleId,
  settings,
  composedPrompt,
  refinement,
  provider,
  runStartedAt,
  imageCostRub,
  compressionCostRub,
  bytes,
  errorCode,
  errorMessage,
}) {
  try {
    await prisma.agentRun.create({
      data: {
        articleId,
        agentName: COVER_AGENT_NAME,
        status: 'failed',
        inputJson: JSON.stringify(buildInputJson({ settings, composedPrompt, refinement, provider })),
        outputJson: JSON.stringify({
          compressionCostRub,
          ...(bytes !== undefined ? { bytes } : {}),
          error: errorCode,
        }),
        error: errorMessage,
        costRub: imageCostRub,
        startedAt: runStartedAt,
        finishedAt: new Date(),
      },
    });
  } catch (ledgerErr) {
    console.error(`[cover-service] failed to record the cover ledger row: ${ledgerErr.message}`);
  }
}
