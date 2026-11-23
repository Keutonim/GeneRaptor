/**
 * Cover-generation feature: shared constants, payload types and
 * machine-code → Russian-message maps for the frozen API contract.
 *
 * Contract source: server/routes/articles.mjs + server/routes/cover-settings.mjs
 * POST /api/articles/:id/cover (action payload + cover_* error codes)
 * GET /api/settings/cover (settings payload + effective values)
 * PUT /api/settings/cover (subset body + cover_settings_* codes)
 * GET /api/articles/:id/content (adds cover* fields, coverAvailable)
 *
 * The agent name must match the server-side ledger row written by
 * server/lib/cover-service.mjs (Track A): every generation appends an
 * agent_run named «Генерация обложки». ArticleDetailsModal filters that
 * run out of the visible stage list via COVER_AGENT_NAME.
 */
import { ApiError } from '../hooks/useApi';

/** agent_run ledger name written by the cover service. */
export const COVER_AGENT_NAME = 'Генерация обложки';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Cover fields as exposed by GET /api/articles/:id/content.
 * The *content* endpoint uses the coverModel/coverCostRub vocabulary;
 * the *action* response uses model/costRub instead.
 */
export interface CoverFields {
  /** Имя файла обложки в локальном хранилище <data-dir>/covers/ (M5). */
  coverFile: string | null;
  /** Причина, по которой обложка недоступна (M5, GET /:id/content). */
  coverUnavailableReason?: string | null;
  coverModel: string | null;
  coverCostRub: number | null;
  /** ISO-8601 timestamp of the last successful generation, if any. */
  coverGeneratedAt?: string | null;
  /**
   * Cover checkbox wave: the per-article cover phase channel
   * (requested|generating|ready|skipped|failed|null). Optional — absent on
   * old payloads; the panel's poll loop propagates it upward via
   * onUpdated so the badge/note/busy states update without a reopen.
   */
  coverStatus?: string | null;
  coverSkipReason?: string | null;
}

/** data payload of a successful POST /api/articles/:id/cover. */
export interface CoverActionResult {
  /** Имя сохранённого файла обложки (M5); байты — GET /api/articles/:id/cover. */
  coverFile: string;
  model: string;
  costRub: number;
  spentThisMonthRub: number;
  monthlyCapRub: number;
  promptPreview: string;
  /** Non-fatal machine codes from the M5 contract. */
  warnings: string[];
}

/** data payload of GET /api/settings/cover. */
export interface CoverSettingsData {
  /** false = the settings row does not exist yet; GET still returns defaults (never 404). */
  configured: boolean;
  enabled: boolean;
  model: string;
  /** EFFECTIVE (resolved) compression model id — never empty in responses. */
  compressionModel: string;
  /** Where the effective compression model came from. */
  compressionModelSource: 'override' | 'env';
  promptTemplate: string;
  aspectRatio: string;
  resolution: string;
  quality: string;
  outputFormat: string;
  autoGenerate: boolean;
  monthlyCapRub: number;
  /**
   * NOT part of the frozen GET contract — rendered as a hint only when the
   * backend chooses to include it (spend hint line is optional).
   */
  spentThisMonthRub?: number | null;
}

/* ------------------------------------------------------------------ */
/*  Machine code → Russian message maps                                */
/* ------------------------------------------------------------------ */

/** Fatal error codes of POST /api/articles/:id/cover (table, verbatim RU). */
export const COVER_ERROR_MESSAGES: Record<string, string> = {
  cover_invalid_refinement: 'Уточнение слишком длинное (до 500 символов).',
  cover_empty_article: 'Сначала сгенерируйте текст статьи — обложка строится по нему.',
  cover_invalid_article_id: 'Некорректный идентификатор статьи.',
  cover_budget_exceeded: 'Лимит на генерацию обложек в этом месяце исчерпан. Обложка не изменена.',
  cover_disabled: 'Генерация обложек отключена в настройках.',
  cover_article_not_found: 'Статья не найдена.',
  cover_in_progress: 'Обложка уже генерируется — дождитесь окончания.',
  cover_generation_failed: 'Не удалось получить изображение у модели. Попробуйте ещё раз.',
  cover_compression_failed: 'Не удалось сжать статью для генерации обложки.',
  cover_save_failed: 'Не удалось сохранить обложку на диск.',
  cover_not_configured: 'Не настроен провайдер для генерации обложек.',
  cover_provider_images_unsupported: 'Провайдер не поддерживает генерацию изображений.',
  cover_not_found: 'Обложка не найдена.',
};

/** Non-fatal warning codes carried in data.warnings[]. */
/** M5: нефатальных предупреждений в контракте обложек нет. */
export const COVER_WARNING_MESSAGES: Record<string, string> = {};

/** PUT /api/settings/cover validation codes. */
export const COVER_SETTINGS_ERROR_MESSAGES: Record<string, string> = {
  cover_settings_unknown_field: 'Неизвестное поле настроек обложек.',
  cover_settings_invalid_enabled: 'Некорректное значение «Генерация обложек включена».',
  cover_settings_invalid_model: 'Некорректный идентификатор модели изображения (не пусто, до 200 символов).',
  cover_settings_invalid_compression_model: 'Некорректный идентификатор модели сжатия статьи (до 200 символов).',
  cover_settings_invalid_prompt_template: 'Шаблон промпта должен быть непустым и не длиннее 8000 символов.',
  cover_settings_invalid_aspect_ratio: 'Такое соотношение сторон не поддерживается.',
  cover_settings_invalid_resolution: 'Допустимые разрешения: 512, 1K, 2K, 4K.',
  cover_settings_invalid_quality: 'Допустимые значения качества: auto, low, medium, high.',
  cover_settings_invalid_output_format: 'Допустимые форматы файла: png, jpeg, webp.',
  cover_settings_invalid_cap: 'Лимит должен быть целым числом от 0 до 100 000 ₽.',
};

/**
 * Russian message for a cover-action failure: machine-code map first, then
 * the server message, then a generic fallback.
 */
export function coverErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code && COVER_ERROR_MESSAGES[err.code]) {
    return COVER_ERROR_MESSAGES[err.code];
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Не удалось сгенерировать обложку';
}

/**
 * Russian message for a settings failure: cover_settings_* map first, then
 * ApiError.message, then Error.message, then fallback.
 */
export function formatCoverSettingsError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return (err.code != null ? COVER_SETTINGS_ERROR_MESSAGES[err.code] : undefined) ?? err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * Russian label for a non-fatal warning code from data.warnings[].
 * Unknown codes are shown as-is (forward compatibility).
 */
export function coverWarningMessage(code: string): string {
  return COVER_WARNING_MESSAGES[code] ?? code;
}

/* ------------------------------------------------------------------ */
/*  Option lists (approved models + aspect ratios)                     */
/* ------------------------------------------------------------------ */

/**
 * Known image models the owner approved (R1). Default = qwen/qwen-image-2.1-pro
 * (flat 4.82 ₽/image). Any other id is reachable via «Другой…» free text —
 * e.g. qwen/qwen-image-3-pro (PC-D1) — settings change, not code.
 */
export const COVER_MODEL_OPTIONS: readonly string[] = [
  'qwen/qwen-image-2.1-pro',
  'google/gemini-nano-banana-2.1',
  'google/gemini-3.1-flash-image',
];

/**
 * Human-readable names of the approved models:
 * the owner sees «Qwen Image 2.1 Pro — qwen/qwen-image-2.1-pro», not a raw id.
 */
export const COVER_MODEL_LABELS: Record<string, string> = {
  'qwen/qwen-image-2.1-pro': 'Qwen Image 2.1 Pro',
  'google/gemini-nano-banana-2.1': 'Gemini Nano Banana 2.1',
  'google/gemini-3.1-flash-image': 'Gemini 3.1 Flash Image',
};

/**
 * Display label of a model id: «Название — id» for a known model, the raw id
 * for a custom one (option labels).
 */
export function coverModelLabel(modelId: string): string {
  const label = COVER_MODEL_LABELS[modelId];
  return label ? `${label} — ${modelId}` : modelId;
}

/**
 * Price caption under the model select: only the published
 * flat-price model has a known cost; token-priced Gemini models and custom
 * ids degrade to «цена зависит от модели».
 */
export function coverModelPriceHint(modelId: string): string {
  if (modelId === 'qwen/qwen-image-2.1-pro') {
    return 'Стоимость обложки: ≈4,82 ₽. Модель оплачивается по факту генерации.';
  }
  return 'Цена зависит от модели — точную стоимость посмотрите в логах генерации.';
}

/** Sentinel select value that reveals the free-text custom model input. */
export const COVER_CUSTOM_MODEL_VALUE = '__custom__';

/**
 * Aspect ratios supported by ALL approved models (intersection of the
 * Gemini 14-option and qwen 13-option lists);
 * 16:9 is the banner default and comes first.
 */
export const COVER_ASPECT_RATIOS: readonly string[] = [
  '16:9',
  '1:1',
  '1:4',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
];

export const COVER_RESOLUTIONS: readonly string[] = ['512', '1K', '2K', '4K'];

export const COVER_QUALITIES: readonly string[] = ['auto', 'low', 'medium', 'high'];

export const COVER_OUTPUT_FORMATS: readonly string[] = ['png', 'jpeg', 'webp'];

/* ------------------------------------------------------------------ */
/*  Client-side defaults                                               */
/* ------------------------------------------------------------------ */

/**
 * Default SYSTEM prompt (R3 — ships verbatim; the server owns
 * the canonical copy and GET /api/settings/cover always returns it, so this
 * constant is only the fallback for a degraded/unavailable settings fetch).
 * Must be stored byte-identical by PUT — never trim or collapse whitespace.
 */
export const DEFAULT_COVER_PROMPT_TEMPLATE =
  'Иллюстрация по теме статьи: спокойная редакционная графика без сторонних брендов и шрифтов. Текст на изображении — на русском языке, он выделяет главные темы статьи. Палитра сдержанная, все внутренние элементы и блоки имеют скругления краёв 8px.';

/** Fallback settings used until GET /api/settings/cover resolves (mirrors server defaults). */
export const DEFAULT_COVER_SETTINGS: CoverSettingsData = {
  configured: false,
  enabled: true,
  model: 'qwen/qwen-image-2.1-pro',
  compressionModel: '',
  compressionModelSource: 'env',
  promptTemplate: DEFAULT_COVER_PROMPT_TEMPLATE,
  aspectRatio: '16:9',
  resolution: '1K',
  quality: 'high',
  outputFormat: 'png',
  autoGenerate: false,
  monthlyCapRub: 300,
};

/* ================================================================== */
/*  Cover checkbox wave                                               */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  — the form checkbox hint (economics)                               */
/* ------------------------------------------------------------------ */

const COVER_HINT_TAIL = 'обложка появится в карточке статьи после генерации';

/**
 * Hint line under the «Сгенерировать обложку» checkbox.
 * Known flat price → «+~5 ₽ · …» (4.82 ₽ honestly rounded with «~»);
 * unknown price (token-priced model / quality auto / old server) →
 * «Цена зависит от модели · …». Pure — unit-tested.
 */
export function coverCheckboxHint(estimatedCoverCostRub: number | null | undefined): string {
  if (
    typeof estimatedCoverCostRub === 'number' &&
    Number.isFinite(estimatedCoverCostRub) &&
    estimatedCoverCostRub > 0
  ) {
    return `+~${Math.round(estimatedCoverCostRub)} ₽ · ${COVER_HINT_TAIL}`;
  }
  return `Цена зависит от модели · ${COVER_HINT_TAIL}`;
}

/** Micro-caption shown while the checkbox is checked (forecast, not fact). */
export const COVER_CHECKED_NOTE = 'Обложка будет создана после генерации статьи';

/** aria-label of the checkbox. */
export const COVER_CHECKBOX_ARIA_LABEL = 'Сгенерировать обложку для статьи';

/* ------------------------------------------------------------------ */
/*  — disabled state from GET /api/settings/cover                      */
/* ------------------------------------------------------------------ */

/** RU reason lines for a disabled checkbox (verbatim). */
const COVER_UNAVAILABLE_MESSAGES: Record<string, string> = {
  cover_disabled:
    'Генерация обложек отключена в настройках сервера.',
  cover_not_configured:
    'Обложка недоступна: не настроен провайдер для генерации обложек или не задан ключ ROUTERAI.',
};

/**
 * RU text for an unavailableReason code; null when the checkbox is not
 * blocked by a known reason (unknown codes stay optimistic, never a guess).
 */
export function coverUnavailableMessage(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || reason === '') return null;
  return COVER_UNAVAILABLE_MESSAGES[reason] ?? null;
}

export interface CoverCheckboxSettingsPayload {
  available?: boolean;
  unavailableReason?: string | null;
  estimatedCoverCostRub?: number | null;
}

export interface CoverCheckboxState {
  /** true ONLY on an explicit available:false + a known reason («Неизвестно» stays enabled). */
  disabled: boolean;
  unavailableReason: string | null;
  /** Effective per-image estimate for the hint; null when unknown. */
  estimatedCoverCostRub: number | null;
}

/**
 * Fold GET /api/settings/cover into the checkbox state.
 * Failure modes stay OPTIMISTIC («Неизвестно»): a null payload
 * (fetch error), an old server without the fields, or a contradicting
 * available:false without a reason → the checkbox stays enabled; the flag
 * still travels to the server and a refusal lands in coverSkipReason.
 */
export function deriveCoverCheckboxState(
  settings: CoverCheckboxSettingsPayload | null | undefined,
): CoverCheckboxState {
  const rawEstimate = settings?.estimatedCoverCostRub;
  const estimatedCoverCostRub =
    typeof rawEstimate === 'number' && Number.isFinite(rawEstimate) ? rawEstimate : null;
  const reason =
    typeof settings?.unavailableReason === 'string' && settings.unavailableReason !== ''
      ? settings.unavailableReason
      : null;
  const disabled = settings?.available === false && coverUnavailableMessage(reason) !== null;
  return { disabled, unavailableReason: disabled ? reason : null, estimatedCoverCostRub };
}

/* ------------------------------------------------------------------ */
/*  — queue-row badge per coverStatus                                  */
/* ------------------------------------------------------------------ */

export type CoverBadgeTone = 'neutral' | 'accent' | 'warning' | 'danger';

export interface CoverBadge {
  label: string;
  tone: CoverBadgeTone;
  /** true → the badge renders a rotating Loader2 next to the label. */
  spinning: boolean;
  title: string;
}

/**
 * note text for a coverSkipReason — also used as the badge tooltip for
 * skipped/failed rows («title: причина из списка причин»).
 */
export function coverSkipNoteMessage(code: string | null | undefined): string {
  if (typeof code !== 'string' || code === '') {
    return 'Обложка не создана. Подробности — в журнале генерации.';
  }
  return (
    COVER_SKIP_NOTE_MESSAGES[code] ?? 'Обложка не создана. Подробности — в журнале генерации.'
  );
}

/**
 * Badge descriptor for a queue row, or null when the row must stay silent
 * (ready / no request → no badge; the cover itself is the signal).
 * @param coverStatus article.coverStatus from serializeArticle
 * @param elapsedSec  live seconds for the generating tooltip («Ожидание: N с»)
 * @param skipReason  article.coverSkipReason for skipped/failed tooltips
 */
export function coverBadge(
  coverStatus: string | null | undefined,
  elapsedSec?: number,
  skipReason?: string | null,
): CoverBadge | null {
  switch (coverStatus) {
    case 'requested':
      return {
        label: 'Обложка после генерации',
        tone: 'neutral',
        spinning: false,
        title: 'Обложка будет создана сразу после готовности текста статьи',
      };
    case 'generating': {
      const base = 'Обычно 1–2 минуты, иногда до 5 минут.';
      const title =
        typeof elapsedSec === 'number' && Number.isFinite(elapsedSec)
          ? `${base} Ожидание: ${Math.max(0, Math.floor(elapsedSec))} с`
          : base;
      return { label: 'Генерация обложки…', tone: 'accent', spinning: true, title };
    }
    case 'skipped':
      return {
        label: 'Обложка пропущена',
        tone: 'warning',
        spinning: false,
        title: coverSkipNoteMessage(skipReason),
      };
    case 'failed':
      return {
        label: 'Обложка не создана',
        tone: 'danger',
        spinning: false,
        title: coverSkipNoteMessage(skipReason),
      };
    default:
      // ready / null / undefined / unknown future states — silent.
      return null;
  }
}

/** coverStatus values that must keep the 15s queue poll alive. */
const COVER_ACTIVE_STATUSES = new Set(['requested', 'generating']);

/**
 * Polling-gate extension: the article turns ready BEFORE the
 * cover phase starts, so the gate must also watch the cover channel —
 * otherwise the «Генерация обложки…» badge would never appear without a
 * manual refresh. Pure — unit-tested; the generation view ORs this with the
 * status gate.
 */
export function hasCoverPhaseItems(items: Array<{ coverStatus?: string | null }>): boolean {
  return items.some((item) => COVER_ACTIVE_STATUSES.has(item.coverStatus ?? ''));
}

/* ------------------------------------------------------------------ */
/*  — skip/fail note (details modal + cover panel)                     */
/* ------------------------------------------------------------------ */

/**
 * copy deck keyed by coverSkipReason. The first five codes repeat the
 * COVER_ERROR_MESSAGES wording; automatic skips add the «Статья готова без
 * обложки…» tail where the design specifies it.
 */
export const COVER_SKIP_NOTE_MESSAGES: Record<string, string> = {
  cover_budget_exceeded:
    'Обложка не создана: лимит на генерацию обложек в этом месяце исчерпан. Статья готова без обложки — создать её можно вручную в панели обложки.',
  cover_disabled: 'Обложка не создана: генерация обложек отключена в настройках.',
  cover_not_configured:
    'Обложка не создана: не настроен провайдер для генерации обложек (нужен ключ ROUTERAI).',
  cover_empty_article:
    'Обложка не создана: сначала сгенерируйте текст статьи — обложка строится по нему.',
  cover_exists:
    'Обложка уже есть — повторная генерация пропущена, лимит не расходуется.',
  cover_generation_failed:
    'Обложка не создана: не удалось получить изображение у модели. Создать обложку можно вручную в панели обложки.',
  cover_save_failed:
    'Обложка не создана: не удалось сохранить обложку на диск.',
  cover_compression_failed:
    'Обложка не создана: не удалось сжать статью для генерации обложки.',
  cover_in_progress: 'Обложка уже генерируется — дождитесь окончания.',
};

export interface CoverSkipNote {
  text: string;
  tone: 'warning' | 'danger';
}

/** Design FAIL_CODES: we tried (maybe spent) and broke → danger tone. */
const COVER_NOTE_DANGER_CODES = new Set([
  'cover_generation_failed',
  'cover_compression_failed',
  'cover_save_failed',
]);

/**
 * The details-modal / panel note for a terminal cover outcome, or null when
 * there is nothing to say (no reason / success — «при успехе её нет»).
 */
export function coverSkipNote(code: string | null | undefined): CoverSkipNote | null {
  if (typeof code !== 'string' || code === '') return null;
  return {
    text: coverSkipNoteMessage(code),
    tone: COVER_NOTE_DANGER_CODES.has(code) ? 'danger' : 'warning',
  };
}

/* ------------------------------------------------------------------ */
/*  CoverPanel self-refresh loop                                       */
/* ------------------------------------------------------------------ */

/** While coverStatus === 'generating' the panel re-polls /content every 5s. */
export const COVER_POLL_INTERVAL_MS = 5000;

/** …but at most ~5 minutes («максимум ~5 минут») — then it gives up. */
export const COVER_POLL_MAX_MS = 300000;

/**
 * true when the refresh loop ran out of its budget. A null start (loop not
 * running) never exceeds.
 */
export function coverPollDeadlineExceeded(
  startedAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return false;
  return nowMs - startedAtMs > COVER_POLL_MAX_MS;
}
