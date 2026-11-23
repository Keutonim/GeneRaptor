/**
 * M6 — компоновер статьи (состояние A).
 *
 * Тема, уточнения к теме (поле на главной
 * форме, счётчик {n}/1000), объём (трёхпозиционный сегмент), «Язык материала»
 * (D6) и флаг обложки. Один основной вызов — «Начать генерацию»: отдельного
 * шага уточнений больше нет, путь один: тема → уточнения → генерация.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { deriveCoverCheckboxState } from '../../data/cover';
import { useI18n } from '../../i18n';
import { apiGet } from '../../hooks/useApi';
import type { Locale } from '../../i18n/dictionary';
import type { MaterialLanguage } from './api';

/** Верхний лимит темы на сервере (server/routes/articles.mjs: TOPIC_MAX_LENGTH). */
export const TOPIC_MAX_LENGTH = 200;

/** Верхний лимит уточнений (сервер: USER_NOTES_TOO_LONG, ≤1000). */
export const NOTES_MAX_LENGTH = 1000;

/** Три объёма из допустимого диапазона сервера (50 000 … 80 000). */
export const VOLUME_CHOICES: { value: number; labelKey: string }[] = [
  { value: 50000, labelKey: 'composer.volume.short' },
  { value: 65000, labelKey: 'composer.volume.medium' },
  { value: 80000, labelKey: 'composer.volume.long' },
];

export interface ComposerDraft {
  topic: string;
  targetLength: number;
  language: MaterialLanguage;
  coverRequested: boolean;
}

export interface ComposerProps {
  onNext: (draft: ComposerDraft) => void;
  providerReady?: boolean;
  error?: string | null;
  warning?: { message: string; suggestion?: string | null } | null;
  /** Тема, предложенная сервером, — подставляется в поле. */
  suggestedTopic?: string | null;
  onUseSuggestion?: (topic: string) => void;
  onForceStart?: () => void;
  /** Уточнения к теме — одно состояние на весь экран генерации. */
  notes: string;
  onNotesChange: (notes: string) => void;
  /** Идёт запуск — главная кнопка заблокирована. */
  busy?: boolean;
}

export const Composer: React.FC<ComposerProps> = ({
  onNext,
  providerReady: providerReadyProp = true,
  error = null,
  warning = null,
  suggestedTopic = null,
  onUseSuggestion,
  onForceStart,
  notes,
  onNotesChange,
  busy = false,
}) => {
  const { t } = useI18n();
  const [topic, setTopic] = useState('');
  const [volume, setVolume] = useState(65000);
  // D6: the article material language is a content choice and must not follow
  // the UI locale — it always starts from the default material language.
  const [language, setLanguage] = useState<MaterialLanguage>('ru');
  const [coverRequested, setCoverRequested] = useState(false);
  const [coverState, setCoverState] = useState({ disabled: false, unavailableReason: null as string | null });
  const [providersConfigured, setProvidersConfigured] = useState(true);

  const providerReady = providerReadyProp && providersConfigured;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await apiGet<unknown>('/api/settings/providers');
        const payload =
          raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)
            ? (raw as { data?: unknown }).data
            : raw;
        const providers = (payload as { providers?: unknown })?.providers;
        if (cancelled || !Array.isArray(providers)) return;
        setProvidersConfigured(
          providers.some((provider) => {
            const card = provider as {
              enabled?: boolean;
              keyConfigured?: boolean;
              keyOptional?: boolean;
            };
            return Boolean(card.enabled) && Boolean(card.keyConfigured || card.keyOptional);
          }),
        );
      } catch {
        // Старый сервер без списка провайдеров — считаем, что провайдер есть.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await apiGet<unknown>('/api/settings/cover');
        const payload =
          raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)
            ? (raw as { data?: unknown }).data
            : raw;
        if (cancelled) return;
        setCoverState(deriveCoverCheckboxState(payload as never));
      } catch {
        // Старый сервер без ответа по обложке — флаг остаётся доступным.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const topicValid = useMemo(
    () => topic.trim().length >= 3 && topic.trim().length <= TOPIC_MAX_LENGTH,
    [topic],
  );

  // Тема, предложенная сервером, заменяет текущую.
  useEffect(() => {
    if (suggestedTopic) setTopic(suggestedTopic);
  }, [suggestedTopic]);

  const submit = () => {
    if (!topicValid) return;
    onNext({ topic: topic.trim(), targetLength: volume, language, coverRequested });
  };

  return (
    <section className="composer panel">
      <h2 className="page-title">{t('composer.title')}</h2>

      {!providerReady ? <p className="caption">{t('composer.provider.missing')}</p> : null}
      {warning ? (
        <div className="panel">
          <p className="caption">{warning.message}</p>
          <div className="button-row">
            {warning.suggestion && onUseSuggestion ? (
              <button
                type="button"
                className="button"
                onClick={() => onUseSuggestion(warning.suggestion as string)}
              >
                {t('composer.useSuggestion')}
              </button>
            ) : null}
            {onForceStart ? (
              <button type="button" className="button" onClick={onForceStart}>
                {t('composer.forceStart')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="field">
        <div className="field__head">
          <label className="field__label" htmlFor="composer-topic">
            {t('composer.topic.label')}
          </label>
          <span className="meta">
            {t('composer.topic.counter', { count: topic.length, max: TOPIC_MAX_LENGTH })}
          </span>
        </div>
        <textarea
          id="composer-topic"
          className="textarea"
          rows={3}
          maxLength={TOPIC_MAX_LENGTH}
          placeholder={t('composer.topic.placeholder')}
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
        />
      </div>

      {/* Уточнения к теме — на главной форме: подпись, счётчик {n}/1000
          справа, maxLength=1000. */}
      <div className="field">
        <div className="field__head">
          <label className="field__label" htmlFor="composer-notes">
            {t('composer.notes.label')}
          </label>
          <span className="meta">
            {t('composer.notes.counter', { count: notes.length, max: NOTES_MAX_LENGTH })}
          </span>
        </div>
        <textarea
          id="composer-notes"
          className="textarea"
          rows={3}
          maxLength={NOTES_MAX_LENGTH}
          placeholder={t('composer.notes.placeholder')}
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
        />
        <span className="caption">{t('composer.notes.hint')}</span>
      </div>

      <div className="field">
        <span className="field__label" id="composer-volume-label">
          {t('composer.volume.label')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="composer-volume-label">
          {VOLUME_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              className="segmented__option"
              aria-checked={volume === choice.value}
              onClick={() => setVolume(choice.value)}
            >
              {t(choice.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label" id="composer-language-label">
          {t('composer.language.label')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="composer-language-label">
          {(['ru', 'en'] as Locale[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              className="segmented__option"
              aria-checked={language === option}
              onClick={() => setLanguage(option === 'en' ? 'en' : 'ru')}
            >
              {option.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="checkbox-row">
        <input
          id="composer-cover"
          type="checkbox"
          checked={coverRequested}
          disabled={coverState.disabled}
          onChange={(event) => setCoverRequested(event.target.checked)}
        />
        <label htmlFor="composer-cover">{t('composer.cover.label')}</label>
      </div>
      {coverState.disabled ? <p className="caption">{t('composer.cover.unavailable')}</p> : null}

      {error ? <p className="error-text">{error}</p> : null}

      <div className="button-row">
        <button
          type="button"
          className="button button--primary"
          disabled={!topicValid || busy}
          onClick={submit}
        >
          {t('composer.primary')}
        </button>
      </div>
    </section>
  );
};
