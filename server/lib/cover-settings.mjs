/**
 * Cover generation settings (single-row table).
 *
 * Conventions:
 *  - one logical row resolved via findFirst({ orderBy: { updatedAt: 'desc' } });
 * - frozen COVER_SETTINGS_DEFAULTS with the values (R3 template as promptTemplate);
 *  - validate → { ok: true } | { ok: false, code, message } with pinned machine codes.
 *
 * compressionModel is stored as null when the operator wants inheritance: the
 * effective value is resolved at READ time via resolveCompressionModel() so an
 * env change (ROUTERAI_MODEL_STANDARD) is picked up without touching the DB row.
 */

import { prisma } from '../db.mjs';
import { DEFAULT_COVER_SYSTEM_PROMPT } from './cover-prompt.mjs';

/** @typedef {Record<string, unknown>} CoverSettingsPatch */

/** Frozen defaults —. promptTemplate has no DB default, it lives here. */
export const COVER_SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  model: 'qwen/qwen-image-2.1-pro',
  compressionModel: null,
  promptTemplate: DEFAULT_COVER_SYSTEM_PROMPT,
  aspectRatio: '16:9',
  resolution: '1K',
  quality: 'high',
  outputFormat: 'png',
  autoGenerate: false,
  monthlyCapRub: 300,
});

/** Persisted fields (exactly the prisma model minus id/updatedAt). */
const SETTINGS_FIELDS = Object.keys(COVER_SETTINGS_DEFAULTS);

/** Row metadata that may ride along in merged objects but is never validated/persisted. */
const META_FIELDS = new Set(['id', 'updatedAt']);

/** Union of provider-supported aspect ratios. */
export const SUPPORTED_ASPECT_RATIOS = Object.freeze([
  '1:1', '1:2', '1:4', '1:8', '2:1', '2:3', '3:2', '3:4',
  '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
]);

export const SUPPORTED_RESOLUTIONS = Object.freeze(['512', '1K', '2K', '4K']);
export const SUPPORTED_QUALITIES = Object.freeze(['auto', 'low', 'medium', 'high']);
export const SUPPORTED_OUTPUT_FORMATS = Object.freeze(['png', 'jpeg', 'webp']);

const MODEL_MAX_LEN = 200;
const TEMPLATE_MAX_LEN = 8000;
const CAP_MIN = 0;
const CAP_MAX = 100000;
const FALLBACK_STANDARD_MODEL = 'deepseek/deepseek-v4-flash';

/** Validation failure carrying a pinned machine code (routes surface it as 400). */
export class CoverSettingsError extends Error {
  /**
   * @param {string} code machine code, e.g. 'cover_settings_invalid_cap'
   * @param {string} message human-readable message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CoverSettingsError';
    this.code = code;
  }
}

function isPlainBoolean(value) {
  return typeof value === 'boolean';
}

function isNonEmptyString(value, maxLen) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

function normalizeCap(value) {
  // Prisma returns Decimal for monthly_cap_rub — accept anything with toNumber().
  if (value !== null && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return value;
}

/**
 * Validate a (possibly partial-merged) cover settings object.
 * Unknown keys → cover_settings_unknown_field.
 * @param {CoverSettingsPatch} settings
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function validateCoverSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    return { ok: false, code: 'cover_settings_unknown_field', message: 'Settings object required' };
  }

  for (const key of Object.keys(settings)) {
    if (!META_FIELDS.has(key) && !SETTINGS_FIELDS.includes(key)) {
      return { ok: false, code: 'cover_settings_unknown_field', message: `Unknown field: ${key}` };
    }
  }

  const fail = (code, message) => ({ ok: false, code, message });

  if ('enabled' in settings && !isPlainBoolean(settings.enabled)) {
    return fail('cover_settings_invalid_enabled', 'enabled must be a boolean');
  }
  if ('model' in settings && !isNonEmptyString(settings.model, MODEL_MAX_LEN)) {
    return fail(
      'cover_settings_invalid_model',
      `model must be a non-empty string (max ${MODEL_MAX_LEN} chars)`,
    );
  }
  if (
    'compressionModel' in settings &&
    settings.compressionModel !== null &&
    !isNonEmptyString(settings.compressionModel, MODEL_MAX_LEN)
  ) {
    return fail(
      'cover_settings_invalid_compression_model',
      `compressionModel must be null or a non-empty string (max ${MODEL_MAX_LEN} chars)`,
    );
  }
  if (
    'promptTemplate' in settings &&
    !isNonEmptyString(settings.promptTemplate, TEMPLATE_MAX_LEN)
  ) {
    return fail(
      'cover_settings_invalid_prompt_template',
      `promptTemplate must be a non-empty string (max ${TEMPLATE_MAX_LEN} chars)`,
    );
  }
  if ('aspectRatio' in settings && !SUPPORTED_ASPECT_RATIOS.includes(settings.aspectRatio)) {
    return fail(
      'cover_settings_invalid_aspect_ratio',
      `aspectRatio must be one of: ${SUPPORTED_ASPECT_RATIOS.join(', ')}`,
    );
  }
  if ('resolution' in settings && !SUPPORTED_RESOLUTIONS.includes(settings.resolution)) {
    return fail(
      'cover_settings_invalid_resolution',
      `resolution must be one of: ${SUPPORTED_RESOLUTIONS.join(', ')}`,
    );
  }
  if ('quality' in settings && !SUPPORTED_QUALITIES.includes(settings.quality)) {
    return fail(
      'cover_settings_invalid_quality',
      `quality must be one of: ${SUPPORTED_QUALITIES.join(', ')}`,
    );
  }
  if ('outputFormat' in settings && !SUPPORTED_OUTPUT_FORMATS.includes(settings.outputFormat)) {
    return fail(
      'cover_settings_invalid_output_format',
      `outputFormat must be one of: ${SUPPORTED_OUTPUT_FORMATS.join(', ')}`,
    );
  }
  if ('autoGenerate' in settings && !isPlainBoolean(settings.autoGenerate)) {
    return fail('cover_settings_invalid_auto_generate', 'autoGenerate must be a boolean');
  }
  if ('monthlyCapRub' in settings) {
    const cap = normalizeCap(settings.monthlyCapRub);
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < CAP_MIN || cap > CAP_MAX) {
      return fail(
        'cover_settings_invalid_cap',
        `monthlyCapRub must be an integer ${CAP_MIN}–${CAP_MAX} (0 blocks generation)`,
      );
    }
  }

  return { ok: true };
}

/**
 * Effective compression model, resolved at read time:
 * stored override → ROUTERAI_MODEL_STANDARD → hardcoded standard fallback.
 * @param {string | null | undefined} stored
 * @returns {string}
 */
export function resolveCompressionModel(stored) {
  if (typeof stored === 'string' && stored.trim().length > 0) return stored;
  const fromEnv = process.env.ROUTERAI_MODEL_STANDARD;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv;
  return FALLBACK_STANDARD_MODEL;
}

/**
 * Shape a raw row (or defaults when absent) into the frozen response contract:
 * exactly the documented keys, Decimal cap → number, effective compressionModel.
 * @param {Record<string, unknown> | null} raw
 */
function shapeSettings(raw) {
  const merged = { ...COVER_SETTINGS_DEFAULTS, ...(raw ?? {}) };
  const hasOverride =
    typeof merged.compressionModel === 'string' && merged.compressionModel.trim().length > 0;
  return {
    configured: raw !== null,
    enabled: merged.enabled,
    model: merged.model,
    compressionModel: resolveCompressionModel(merged.compressionModel),
    compressionModelSource: hasOverride ? 'override' : 'env',
    promptTemplate: merged.promptTemplate,
    aspectRatio: merged.aspectRatio,
    resolution: merged.resolution,
    quality: merged.quality,
    outputFormat: merged.outputFormat,
    autoGenerate: merged.autoGenerate,
    monthlyCapRub: Number(normalizeCap(merged.monthlyCapRub)),
  };
}

/**
 * Read the effective cover settings. No row → defaults with configured:false (never 404).
 * @returns {Promise<ReturnType<typeof shapeSettings>>}
 */
export async function getCoverSettings() {
  const raw = await prisma.coverSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  return shapeSettings(raw);
}

/**
 * Merge patch over (stored row ?? defaults), validate, persist create-or-update.
 * Empty-string compressionModel normalizes to null (inherit) BEFORE validation.
 * @param {CoverSettingsPatch} patch subset of SETTINGS_FIELDS
 * @returns {Promise<ReturnType<typeof shapeSettings>>} shaped persisted settings
 * @throws {CoverSettingsError} invalid or unknown fields (route surfaces 400)
 */
export async function saveCoverSettings(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new CoverSettingsError('cover_settings_unknown_field', 'Settings object required');
  }

  const normalized = { ...patch };
  if (normalized.compressionModel === '') normalized.compressionModel = null;
  if ('monthlyCapRub' in normalized) {
    normalized.monthlyCapRub = normalizeCap(normalized.monthlyCapRub);
  }

  const existing = await prisma.coverSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  const merged = {
    ...COVER_SETTINGS_DEFAULTS,
    ...(existing ? normalizeRow(existing) : {}),
    ...normalized,
  };

  const validation = validateCoverSettings(merged);
  if (!validation.ok) {
    throw new CoverSettingsError(validation.code, validation.message);
  }

  const data = {};
  for (const field of SETTINGS_FIELDS) {
    data[field] = merged[field];
  }

  const saved = existing
    ? await prisma.coverSettings.update({ where: { id: existing.id }, data })
    : await prisma.coverSettings.create({ data });

  return shapeSettings(saved);
}

/** Strip Decimal/meta quirks from a raw prisma row before merging. */
function normalizeRow(row) {
  return {
    ...row,
    monthlyCapRub: normalizeCap(row.monthlyCapRub),
  };
}
