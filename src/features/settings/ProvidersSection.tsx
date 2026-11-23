/**
 * M6 — раздел «Провайдеры и ключи».
 *
 * Карточка на провайдера: адрес, индикатор источника ключа (D10 —
 * локальное хранилище или переменная окружения), проверка провайдера с
 * 30-секундным кулдауном и сохранение ключа через сервер.
 *
 * Бейдж поддержки изображений (D9) убран из карточки — это свойство
 * вида провайдера, а не действие; фактическая модель обложки показывается
 * в разделе «Модели» (уровень cover).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { ApiError } from '../../hooks/useApi';
import { fetchProviders, probeProvider, saveProvider, type ProbeResult } from './api';
import type { ProviderCard } from './helpers/models';
import { SearchSourcesBlock } from './SearchSourcesBlock';

/** Кулдаун повторной проверки (server: PROBE_COOLDOWN_MS = 30 000). */
const PROBE_COOLDOWN_MS = 30_000;

/**
 * Адрес редактируется только у видов с пользовательским endpoint
 * (server: FIXED_PROVIDER_KINDS = routerai/openrouter — адрес запрещён).
 * У custom адрес обязателен (custom_base_url_required), у ollama — опционален
 * (пустое значение откатывается к адресу реестра).
 */
const EDITABLE_ENDPOINT_KINDS = new Set(['custom', 'ollama']);

/** Машинные коды сервера → переводимые ключи (показываются у поля). */
const ENDPOINT_ERROR_KEYS: Record<string, string> = {
  provider_url_required: 'providers.endpoint.error.provider_url_required',
  provider_url_invalid: 'providers.endpoint.error.provider_url_invalid',
  provider_url_scheme: 'providers.endpoint.error.provider_url_scheme',
  provider_url_credentials: 'providers.endpoint.error.provider_url_credentials',
  provider_url_private: 'providers.endpoint.error.provider_url_private',
  provider_url_not_allowed: 'providers.endpoint.error.provider_url_not_allowed',
  provider_url_unresolved: 'providers.endpoint.error.provider_url_unresolved',
  custom_base_url_required: 'providers.endpoint.error.custom_base_url_required',
};

interface ProbeState {
  status: 'idle' | 'checking' | 'done';
  result?: ProbeResult;
  cooldownUntil?: number;
}

export const ProvidersSection: React.FC = () => {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Редактируемый адрес (сервер — источник правды, перечитываем после save). */
  const [endpoints, setEndpoints] = useState<Record<string, string>>({});
  const [endpointErrors, setEndpointErrors] = useState<Record<string, string | null>>({});
  const [endpointSaved, setEndpointSaved] = useState<string | null>(null);
  const [savingEndpoint, setSavingEndpoint] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchProviders();
      setProviders(list);
      setEndpoints(Object.fromEntries(list.map((provider) => [provider.kind, provider.baseUrl ?? ''])));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('errors.load'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const keySourceText = (provider: ProviderCard): string => {
    if (provider.keySource === 'local') return t('providers.key.sourceLocal');
    if (provider.keySource === 'env') return t('providers.key.sourceEnv', { key: provider.envKey ?? '' });
    return t('providers.key.sourceNone');
  };

  const runProbe = async (provider: ProviderCard) => {
    setProbes((prev) => ({ ...prev, [provider.kind]: { status: 'checking' } }));
    try {
      const result = await probeProvider(provider.kind);
      setProbes((prev) => ({
        ...prev,
        [provider.kind]: {
          status: 'done',
          result,
          cooldownUntil: Date.now() + PROBE_COOLDOWN_MS,
        },
      }));
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [provider.kind]: {
          status: 'done',
          result: { level: 'error', message: error instanceof Error ? error.message : t('errors.generic') },
          cooldownUntil: Date.now() + PROBE_COOLDOWN_MS,
        },
      }));
    }
  };

  const submitKey = async (provider: ProviderCard) => {
    const value = (keys[provider.kind] ?? '').trim();
    if (!value) return;
    try {
      await saveProvider(provider.kind, { apiKey: value });
      setKeys((prev) => ({ ...prev, [provider.kind]: '' }));
      setSaved(provider.kind);
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('errors.generic'));
    }
  };

  /** Сохранение адреса существующим контрактом saveProvider(kind, { baseUrl }). */
  const submitEndpoint = async (provider: ProviderCard) => {
    const kind = provider.kind;
    const raw = (endpoints[kind] ?? '').trim();
    const fail = (key: string) =>
      setEndpointErrors((prev) => ({ ...prev, [kind]: t(key) }));

    // Мягкая клиентская проверка до запроса (сервер остаётся источником правды).
    if (kind === 'custom' && !raw) {
      fail('providers.endpoint.error.custom_base_url_required');
      return;
    }
    if (raw) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        fail('providers.endpoint.error.provider_url_invalid');
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail('providers.endpoint.error.provider_url_scheme');
        return;
      }
      if (url.username || url.password) {
        fail('providers.endpoint.error.provider_url_credentials');
        return;
      }
    }

    setSavingEndpoint(kind);
    setEndpointErrors((prev) => ({ ...prev, [kind]: null }));
    try {
      await saveProvider(kind, { baseUrl: raw });
      setEndpointSaved(kind);
      await load();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      const key = code ? ENDPOINT_ERROR_KEYS[code] : undefined;
      setEndpointErrors((prev) => ({
        ...prev,
        [kind]: key
          ? t(key)
          : error instanceof Error
            ? error.message
            : t('errors.generic'),
      }));
    } finally {
      setSavingEndpoint(null);
    }
  };

  return (
    <div className="stack">
      {loadError ? <p className="error-text">{loadError}</p> : null}

      <div className="provider-cards">
        {providers.map((provider) => {
          const probe = probes[provider.kind];
          const cooldownLeft = probe?.cooldownUntil
            ? Math.max(0, Math.ceil((probe.cooldownUntil - now) / 1000))
            : 0;
          const cooldownActive = cooldownLeft > 0;

          return (
            <div className="provider-card" key={provider.kind}>
              <h3 className="provider-card__title">{provider.label}</h3>

              {provider.baseUrl ? (
                <span className="provider-card__url">{provider.baseUrl}</span>
              ) : null}

              {EDITABLE_ENDPOINT_KINDS.has(provider.kind) ? (
                <div className="field">
                  <label className="field__label" htmlFor={`provider-endpoint-${provider.kind}`}>
                    {t('providers.endpoint.label')}
                  </label>
                  <div className="button-row">
                    <input
                      id={`provider-endpoint-${provider.kind}`}
                      className="input"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      placeholder={t('providers.endpoint.placeholder')}
                      value={endpoints[provider.kind] ?? ''}
                      aria-invalid={Boolean(endpointErrors[provider.kind])}
                      aria-describedby={
                        endpointErrors[provider.kind] ? `provider-endpoint-error-${provider.kind}` : undefined
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        setEndpoints((prev) => ({ ...prev, [provider.kind]: value }));
                        setEndpointErrors((prev) => ({ ...prev, [provider.kind]: null }));
                      }}
                    />
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={savingEndpoint === provider.kind}
                      onClick={() => void submitEndpoint(provider)}
                    >
                      {t('providers.endpoint.save')}
                    </button>
                  </div>
                  {endpointErrors[provider.kind] ? (
                    <p
                      className="error-text"
                      id={`provider-endpoint-error-${provider.kind}`}
                      data-testid={`provider-endpoint-error-${provider.kind}`}
                    >
                      {endpointErrors[provider.kind]}
                    </p>
                  ) : null}
                  {endpointSaved === provider.kind ? (
                    <span className="caption">{t('roles.saved')}</span>
                  ) : null}
                  {provider.kind === 'custom' ? (
                    <p className="caption">{t('providers.endpoint.customHint')}</p>
                  ) : null}
                </div>
              ) : (
                <p className="caption">{t('providers.endpoint.locked')}</p>
              )}

              <p className="caption">
                {t('providers.key.source')}: {keySourceText(provider)}
              </p>

              <div className="field">
                <label className="field__label" htmlFor={`provider-key-${provider.kind}`}>
                  {t('providers.key.label')}
                </label>
                <div className="button-row">
                  <input
                    id={`provider-key-${provider.kind}`}
                    className="input"
                    type={revealed[provider.kind] ? 'text' : 'password'}
                    autoComplete="off"
                    value={keys[provider.kind] ?? ''}
                    onChange={(event) =>
                      setKeys((prev) => ({ ...prev, [provider.kind]: event.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      setRevealed((prev) => ({ ...prev, [provider.kind]: !prev[provider.kind] }))
                    }
                  >
                    {revealed[provider.kind] ? t('providers.key.hide') : t('providers.key.show')}
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={!(keys[provider.kind] ?? '').trim()}
                    onClick={() => void submitKey(provider)}
                  >
                    {t('providers.key.save')}
                  </button>
                </div>
                {saved === provider.kind ? <span className="caption">{t('roles.saved')}</span> : null}
              </div>

              <div className="button-row">
                <button
                  type="button"
                  className="button"
                  disabled={probe?.status === 'checking' || cooldownActive}
                  onClick={() => void runProbe(provider)}
                >
                  {probe?.status === 'checking'
                    ? t('providers.checking')
                    : cooldownActive
                      ? t('providers.cooldown', { seconds: cooldownLeft })
                      : t('providers.check')}
                </button>
                {probe?.result?.checkedAt ? (
                  <span className="meta">
                    {t('providers.checkedAt', { value: new Date(probe.result.checkedAt).toLocaleString() })}
                  </span>
                ) : null}
              </div>

              {probe?.result?.message ? (
                <p className={probe.result.level === 'error' ? 'error-text' : 'caption'}>
                  {probe.result.message}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <SearchSourcesBlock />
    </div>
  );
};
