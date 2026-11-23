/**
 * CoverSettings — «Генерация обложек» settings panel.
 *
 * Frozen contract (shipped API: server/routes/cover-settings.mjs +
 * server/lib/cover-settings.mjs):
 *   GET  /api/settings/cover → { success:true, data: CoverSettingsData }
 *        (no row yet → configured:false + server defaults, never 404);
 *   PUT  /api/settings/cover → body = ANY SUBSET of writable fields;
 *        unknown keys are rejected (cover_settings_unknown_field), so the PUT
 *        body must never carry configured / compressionModelSource / id /
 *        updatedAt. compressionModel:'' → null → inherit ROUTERAI_MODEL_STANDARD.
 *        promptTemplate is stored BYTE-IDENTICAL — no trim/whitespace collapse;
 *   field set with exact RU labels; error table → src/data/cover.ts.
 *
 * Placement (the shipped cover settings tab):
 *   - ONE component for both entry points — the editor lives in
 *     Настройки → «Генерация обложек» (CoverSettings), the queue only links
 *     to it. `embedded` drops the outer white card so the tab does not
 *     show a card inside a card.
 *   - RU copy follows the design copy deck verbatim.
 *   - Server contract untouched: no new fields are written, only read.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Save } from 'lucide-react';
import { apiGet, apiPut } from '../hooks/useApi';
import '../styles/cover.css';
import {
  COVER_ASPECT_RATIOS,
  COVER_CUSTOM_MODEL_VALUE,
  COVER_MODEL_OPTIONS,
  COVER_OUTPUT_FORMATS,
  COVER_QUALITIES,
  COVER_RESOLUTIONS,
  DEFAULT_COVER_PROMPT_TEMPLATE,
  coverModelLabel,
  coverModelPriceHint,
  formatCoverSettingsError,
} from '../data/cover';

type ApiEnvelope<T> = { success?: boolean; data?: T; error?: string; code?: string };

/* ------------------------------------------------------------------ */
/*  Settings shape                                                     */
/* ------------------------------------------------------------------ */

/**
 * UI state of the panel. Differs from the GET payload in one point:
 * `compressionModel` holds the EDITABLE OVERRIDE ('' = inherit from env),
 * while the effective resolved value lives in `compressionModelEffective`
 * and is only displayed (GET returns the effective value +
 * compressionModelSource).
 */
type CoverSettingsUi = {
  configured: boolean;
  enabled: boolean;
  /** Known model id from COVER_MODEL_OPTIONS or a free-text custom id. */
  model: string;
  /** Override value; '' = inherit ROUTERAI_MODEL_STANDARD. */
  compressionModel: string;
  /** Effective (resolved) compression model from GET — display only. */
  compressionModelEffective: string;
  compressionModelSource: 'override' | 'env';
  promptTemplate: string;
  aspectRatio: string;
  resolution: string;
  quality: string;
  outputFormat: string;
  autoGenerate: boolean;
  monthlyCapRub: number;
  /** Optional spend hint (not in the frozen GET contract). */
  spentThisMonthRub: number | null;
  /** 'cover_disabled' | 'cover_not_configured' | null (GET). */
  unavailableReason: string | null;
};

const DEFAULT_UI: CoverSettingsUi = {
  configured: false,
  enabled: true,
  model: 'qwen/qwen-image-2.1-pro',
  compressionModel: '',
  compressionModelEffective: '',
  compressionModelSource: 'env',
  promptTemplate: DEFAULT_COVER_PROMPT_TEMPLATE,
  aspectRatio: '16:9',
  resolution: '1K',
  quality: 'high',
  outputFormat: 'png',
  autoGenerate: false,
  monthlyCapRub: 300,
  spentThisMonthRub: null,
  unavailableReason: null,
};

/* ------------------------------------------------------------------ */
/* Copy */
/* ------------------------------------------------------------------ */

/** Server-side template limit (server/lib/cover-settings.mjs TEMPLATE_MAX_LEN). */
const TEMPLATE_MAX_LEN = 8000;

/** Placeholder = first ~140 chars of the default template + ellipsis. */
const DEFAULT_TEMPLATE_PLACEHOLDER = `${DEFAULT_COVER_PROMPT_TEMPLATE.slice(0, 140).trimEnd()}…`;

/** «1 240 / 8 000 символов» — non-breaking space as thousands separator. */
function formatCharCount(value: number): string {
  return value.toLocaleString('ru-RU').replace(/\s/g, '\u00A0');
}

/** «Сохранено: 14:32». */
function formatSavedAt(date: Date): string {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ */
/*  Styles                                                              */
/* ------------------------------------------------------------------ */

/*
 * The presentation moved from inline styles to src/styles/cover.css.
 * The hardcoded light palette (teal #00A884, amber blocks) was a second
 * brand colour inside the app and did not survive the dark theme.
 */

/* ------------------------------------------------------------------ */
/*  Normalizers (enum / int guards)                                    */
/* ------------------------------------------------------------------ */

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampIntInput(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Defensive cast of the GET payload into the UI shape (never throws). */
function normalizeSettings(raw: unknown): CoverSettingsUi {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const model = typeof r.model === 'string' && r.model.trim() !== '' && r.model.length <= 200
    ? r.model
    : DEFAULT_UI.model;
  const source = enumOr(r.compressionModelSource, ['override', 'env'] as const, 'env');
  const effective =
    typeof r.compressionModel === 'string' ? r.compressionModel : DEFAULT_UI.compressionModelEffective;
  return {
    configured: r.configured === true,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_UI.enabled,
    model,
    // Editable field = the override only; env-sourced value stays a hint.
    compressionModel: source === 'override' ? effective : '',
    compressionModelEffective: effective,
    compressionModelSource: source,
    promptTemplate: typeof r.promptTemplate === 'string' ? r.promptTemplate : DEFAULT_UI.promptTemplate,
    aspectRatio: enumOr(r.aspectRatio, COVER_ASPECT_RATIOS, DEFAULT_UI.aspectRatio),
    resolution: enumOr(r.resolution, COVER_RESOLUTIONS, DEFAULT_UI.resolution),
    quality: enumOr(r.quality, COVER_QUALITIES, DEFAULT_UI.quality),
    outputFormat: enumOr(r.outputFormat, COVER_OUTPUT_FORMATS, DEFAULT_UI.outputFormat),
    autoGenerate: typeof r.autoGenerate === 'boolean' ? r.autoGenerate : DEFAULT_UI.autoGenerate,
    monthlyCapRub:
      typeof r.monthlyCapRub === 'number' && Number.isFinite(r.monthlyCapRub)
        ? Math.min(100000, Math.max(0, Math.round(r.monthlyCapRub)))
        : DEFAULT_UI.monthlyCapRub,
    spentThisMonthRub:
      typeof r.spentThisMonthRub === 'number' && Number.isFinite(r.spentThisMonthRub)
        ? r.spentThisMonthRub
        : null,
    unavailableReason: typeof r.unavailableReason === 'string' ? r.unavailableReason : null,
  };
}

/**
 * PUT body: writable subset ONLY (rejects unknown keys). Never include
 * configured / compressionModelSource / spentThisMonthRub / id / updatedAt.
 * promptTemplate passes through BYTE-IDENTICAL (no trim).
 */
function buildPutBody(s: CoverSettingsUi): Record<string, unknown> {
  return {
    enabled: s.enabled,
    model: s.model.trim().slice(0, 200),
    compressionModel: s.compressionModel.trim().slice(0, 200),
    promptTemplate: s.promptTemplate,
    aspectRatio: s.aspectRatio,
    resolution: s.resolution,
    quality: s.quality,
    outputFormat: s.outputFormat,
    autoGenerate: s.autoGenerate,
    monthlyCapRub: Math.min(100000, Math.max(0, Math.round(s.monthlyCapRub))),
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const SETTINGS_URL = '/api/settings/cover';

/** Toggle switch markup (switch + visible label). */
function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <label className="cover-settings__switch" aria-label={ariaLabel}>
      <input
        type="checkbox"
        className="cover-settings__switch-input"
        checked={checked}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
      />
      <span className="cover-settings__switch-track" aria-hidden="true">
        <span className="cover-settings__switch-thumb" />
      </span>
    </label>
  );
}

export function CoverSettings({
  embedded = false,
  onSaved,
}: {
  embedded?: boolean;
  /** Fired after a successful save so derived views (Models table) refresh. */
  onSaved?: () => void;
}) {
  const [settings, setSettings] = useState<CoverSettingsUi>(DEFAULT_UI);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  /** Reset-to-template notice; hadEdits = unsaved edits were replaced. */
  const [resetNotice, setResetNotice] = useState<{ hadEdits: boolean } | null>(null);

  const patch = useCallback((partial: Partial<CoverSettingsUi>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const payload = await apiGet<ApiEnvelope<unknown>>(SETTINGS_URL);
      setSettings(normalizeSettings(payload?.data));
    } catch (err) {
      setSaveError(formatCoverSettingsError(err, 'Не удалось загрузить настройки обложек'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaveError(null);
    setSaveNotice(null);
    // Client-side pre-validation mirroring codes (server stays the source of truth).
    if (settings.model.trim() === '') {
      setSaveError('Укажите модель изображения (или выберите одну из списка).');
      return;
    }
    if (settings.promptTemplate.trim() === '') {
      setSaveError('Шаблон промпта не должен быть пустым.');
      return;
    }
    if (settings.promptTemplate.length > TEMPLATE_MAX_LEN) {
      setSaveError('Шаблон промпта слишком длинный (до 8000 символов).');
      return;
    }
    setSaving(true);
    try {
      await apiPut(SETTINGS_URL, buildPutBody(settings));
      setSaveNotice(`Сохранено: ${formatSavedAt(new Date())}`);
      setResetNotice(null);
      // Re-read so the effective compression model / configured flag refresh.
      await loadSettings();
      // Notify the host so the derived cover row in Models refreshes.
      onSaved?.();
    } catch (err) {
      setSaveError(
        formatCoverSettingsError(err, 'Не удалось сохранить настройки. Проверьте соединение и повторите попытку.'),
      );
    } finally {
      setSaving(false);
    }
  }, [saving, settings, loadSettings, onSaved]);

  /** «Сбросить к шаблону» — local only, nothing is saved. */
  const handleResetTemplate = useCallback(() => {
    const hadEdits = settings.promptTemplate !== DEFAULT_COVER_PROMPT_TEMPLATE;
    patch({ promptTemplate: DEFAULT_COVER_PROMPT_TEMPLATE });
    setResetNotice({ hadEdits });
  }, [patch, settings.promptTemplate]);

  const shellClassName = embedded ? 'cover-settings' : 'cover-settings cover-settings--card';

  if (loading) {
    return (
      <section className={shellClassName}>
        <p className="caption">Загрузка настроек…</p>
      </section>
    );
  }

  const isKnownModel = (COVER_MODEL_OPTIONS as readonly string[]).includes(settings.model);
  const modelSelectValue = isKnownModel ? settings.model : COVER_CUSTOM_MODEL_VALUE;
  const compressionSourceText =
    settings.compressionModelSource === 'override'
      ? 'Переопределено вами.'
      : 'Наследуется из ROUTERAI_MODEL_STANDARD.';
  const promptLength = settings.promptTemplate.length;
  const promptTooLong = promptLength > TEMPLATE_MAX_LEN;
  const budgetExhausted =
    settings.spentThisMonthRub != null && settings.spentThisMonthRub >= settings.monthlyCapRub;
  const integrationsMissing = settings.unavailableReason === 'cover_not_configured';

  return (
    <section className={shellClassName} aria-label="Настройки генерации обложек">
      {/* The section title above the panel already names it — the panel
          repeats it only when it stands alone. */}
      {!embedded ? (
        <header className="cover-settings__head">
          <div className="cover-settings__title">Генерация обложек</div>
          <div className="cover-settings__hint">
            Модель изображения, шаблон промпта агента-иллюстратора и лимит расходов на обложки.
          </div>
        </header>
      ) : null}

      <p className="cover-settings__hint">
        Настройки общие для всех источников и действуют для всех новых обложек.
      </p>

      {!settings.configured && (
        <div className="cover-settings__notice">
          Настройки ещё не сохранялись — показаны значения по умолчанию. Нажмите «Сохранить», чтобы создать их.
        </div>
      )}

      {integrationsMissing && (
        <div className="cover-settings__notice">
          Обложки не будут созданы, пока не настроен провайдер для генерации обложек и не задан ключ ROUTERAI.
          Проверьте раздел «Провайдеры и ключи».
        </div>
      )}

      <div className="cover-settings__row">
        <span className="field__label">Генерация обложек включена</span>
        <ToggleSwitch
          checked={settings.enabled}
          onChange={(next) => patch({ enabled: next })}
          ariaLabel="Генерация обложек включена"
        />
      </div>
      <p className="cover-settings__hint">
        Когда выключено, генерация из панели статьи вернёт «Генерация обложек отключена в настройках».
      </p>

      <section className="cover-settings__block">
        <h3 className="cover-settings__block-title">Параметры генерации</h3>

        <label className="cover-settings__param">
          <span className="field__label">Модель изображения *</span>
          <select
            className="select"
            value={modelSelectValue}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const v = e.target.value;
              if (v === COVER_CUSTOM_MODEL_VALUE) {
                // Reveal the free-text input with an empty custom id.
                patch({ model: '' });
              } else {
                patch({ model: v });
              }
            }}
          >
            {COVER_MODEL_OPTIONS.map((id) => (
              <option key={id} value={id}>
                {coverModelLabel(id)}
              </option>
            ))}
            <option value={COVER_CUSTOM_MODEL_VALUE}>Другая модель…</option>
          </select>
          {!isKnownModel && (
            <input
              className="input"
              type="text"
              value={settings.model}
              onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ model: e.target.value })}
              placeholder="Например: qwen/qwen-image-3-pro"
              maxLength={200}
            />
          )}
          <span className="cover-settings__hint">{coverModelPriceHint(settings.model)}</span>
        </label>

        <label className="cover-settings__param">
          <span className="field__label">Модель сжатия статьи</span>
          <input
            className="input"
            type="text"
            value={settings.compressionModel}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ compressionModel: e.target.value })}
            placeholder="Наследуется из ROUTERAI_MODEL_STANDARD"
            maxLength={200}
          />
          <span className="cover-settings__hint">
            {compressionSourceText}
            {settings.compressionModelEffective !== '' &&
              ` Сейчас используется: ${settings.compressionModelEffective}.`}{' '}
            Оставьте поле пустым, чтобы наследовать модель из переменной окружения.
          </span>
        </label>

        <div className="cover-settings__grid">
          <label className="cover-settings__param">
            <span className="field__label">Формат</span>
            <select
              className="select"
              value={settings.aspectRatio}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => patch({ aspectRatio: e.target.value })}
            >
              {COVER_ASPECT_RATIOS.map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio}
                </option>
              ))}
            </select>
            <span className="cover-settings__hint">
              16:9 — формат баннера по умолчанию. Список = пересечение поддержанных ratios всех моделей.
            </span>
          </label>

          <label className="cover-settings__param">
            <span className="field__label">Разрешение</span>
            <select
              className="select"
              value={settings.resolution}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => patch({ resolution: e.target.value })}
            >
              {COVER_RESOLUTIONS.map((res) => (
                <option key={res} value={res}>
                  {res}
                </option>
              ))}
            </select>
            <span className="cover-settings__hint">
              Модель qwen/qwen-image-2.1-pro поддерживает только 1K и 2K.
            </span>
          </label>

          <label className="cover-settings__param">
            <span className="field__label">Качество</span>
            <select
              className="select"
              value={settings.quality}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => patch({ quality: e.target.value })}
            >
              {COVER_QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <span className="cover-settings__hint">
              {settings.quality === 'auto'
                ? 'При «auto» итоговая цена изображения заранее неизвестна — списание подтвердит ответ генерации.'
                : 'Фиксированное качество делает цену предсказуемой.'}
            </span>
          </label>

          <label className="cover-settings__param">
            <span className="field__label">Файл</span>
            <select
              className="select"
              value={settings.outputFormat}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => patch({ outputFormat: e.target.value })}
            >
              {COVER_OUTPUT_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {fmt}
                </option>
              ))}
            </select>
            <span className="cover-settings__hint">Формат файла обложки: PNG, JPEG или WebP.</span>
          </label>
        </div>
      </section>

      <section className="cover-settings__block">
        <h3 className="cover-settings__block-title">Промпт агента-иллюстратора</h3>

        <div className="cover-settings__note">
          Это системный промпт агента-иллюстратора. {'{articleBrief}'} — сжатые тезисы статьи, {'{refinement}'} —
          ваше уточнение, {'{title}'} — заголовок статьи. Если токен не использовать, сервер подставит его сам.
        </div>

        <div className="cover-settings__stack">
          <div className="cover-settings__row">
            <span className="field__label">Шаблон промпта (SYSTEM)</span>
            <span className={promptTooLong ? 'error-text' : 'meta'}>
              {formatCharCount(promptLength)} / {formatCharCount(TEMPLATE_MAX_LEN)} символов
            </span>
          </div>
          <textarea
            className="textarea"
            value={settings.promptTemplate}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              patch({ promptTemplate: e.target.value });
              setResetNotice(null);
            }}
            rows={6}
            placeholder={DEFAULT_TEMPLATE_PLACEHOLDER}
          />
          <div className="cover-settings__row">
            <span className="cover-settings__hint">
              Шаблон по умолчанию — нейтральный редакционный текст: спокойная иллюстрация по теме статьи, без сторонних
              брендов, шрифтов и фирменной палитры, скругления 8px.
            </span>
            <button type="button" className="button" onClick={handleResetTemplate}>
              Сбросить к шаблону
            </button>
          </div>
          {resetNotice && (
            <div className="cover-settings__hint">
              В поле восстановлен шаблон по умолчанию. Нажмите «Сохранить», чтобы применить.
              {resetNotice.hadEdits && ' Несохранённые правки поля заменены шаблоном по умолчанию.'}
            </div>
          )}
          <div className="cover-settings__hint">
            Шаблон применяется ко всем новым обложкам. Уже созданные обложки не изменятся.
          </div>
        </div>
      </section>

      <section className="cover-settings__block">
        <h3 className="cover-settings__block-title">Автоматизация и бюджет</h3>

        <div className="cover-settings__row">
          <span className="field__label">Генерировать автоматически</span>
          <ToggleSwitch
            checked={settings.autoGenerate}
            onChange={(next) => patch({ autoGenerate: next })}
            ariaLabel="Генерировать автоматически"
          />
        </div>
        <div className="cover-settings__hint">
          {settings.autoGenerate
            ? 'Обложка создаётся для всех новых статей — отмечать «Сгенерировать обложку» в форме статьи не нужно.'
            : 'Обложка создаётся только для тех статей, где вы отметили «Сгенерировать обложку» в форме статьи.'}
        </div>
        <div className="cover-settings__hint">
          На старте функции рекомендуется держать выключенным.
        </div>

        <label className="cover-settings__param">
          <span className="field__label">Лимит в месяц, ₽</span>
          <input
            className="input"
            type="number"
            min={0}
            max={100000}
            step={1}
            value={settings.monthlyCapRub}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              patch({ monthlyCapRub: clampIntInput(e.target.value, 0, 100000, settings.monthlyCapRub) })
            }
          />
          <span className="cover-settings__hint">
            Учитывается только стоимость изображений. 0 ₽ — генерация обложек заблокирована до конца месяца.
            {settings.spentThisMonthRub != null && (
              <>
                {' '}
                Потрачено в этом месяце: {settings.spentThisMonthRub.toFixed(2)} ₽ из {settings.monthlyCapRub} ₽.
              </>
            )}
          </span>
        </label>

        {budgetExhausted && (
          <div className="cover-settings__notice cover-settings__notice--warning">
            Лимит месяца исчерпан — новые обложки не генерируются.
            <br />
            Увеличьте лимит в поле выше или дождитесь следующего месяца (учёт ведётся по Москве).
          </div>
        )}
      </section>

      <div className="cover-settings__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={saving}
          onClick={() => {
            void handleSave();
          }}
        >
          <Save size={15} strokeWidth={1.5} aria-hidden="true" />
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        {saveNotice && !saveError && <div className="caption">{saveNotice}</div>}
        {saveError && (
          <div className="error-text" role="alert">
            {saveError}
          </div>
        )}
      </div>
    </section>
  );
}
