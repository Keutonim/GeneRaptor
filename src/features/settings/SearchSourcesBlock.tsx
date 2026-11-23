/**
 * Блок «Поисковые источники».
 *
 * Выбор поискового бэкенда для веб-поиска. Сервер задаёт бэкенд по
 * окружению (GENERAPTOR_SEARCH_BACKEND), поэтому выбор пользователя
 * хранится в браузере и уходит в POST /api/search/search полем `backend`.
 *
 * Блок свёрнут по умолчанию (нативный <details>) и живёт ВНУТРИ секции
 * «Провайдеры и ключи» — количество секций настроек не меняется.
 * Все видимые строки берутся из i18n-словаря (RU/EN).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  fetchSearchBackends,
  probeSearchBackend,
  searchWeb,
  type SearchBackendsPayload,
  type SearchResultItem,
} from './api';
import {
  SEARCH_BACKEND_STORAGE_KEY,
  backendLabelKey,
  backendState,
  collectVerticals,
  isProbeable,
  probeOutcomeKey,
  probeOutcomeTone,
  providerLabelKey,
  resolveSelectedBackend,
  resultProviderId,
  searchOutcomeKey,
  searchOutcomeTone,
  selectableBackends,
  type SearchBackendInfo,
  type SearchMessageTone,
} from './helpers/searchSources';

interface ProbeMessage {
  tone: SearchMessageTone;
  key: string;
  latencyMs?: number;
}

interface SearchMessage {
  tone: SearchMessageTone;
  key: string;
  count: number;
  items: SearchResultItem[];
  fallbackBackend?: string | null;
}

/** Прочитать сохранённый выбор (localStorage может быть недоступен). */
function readStoredBackend(): string | null {
  try {
    return window.localStorage.getItem(SEARCH_BACKEND_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Сохранить выбор (в приватном режиме хранилище может быть недоступно). */
function writeStoredBackend(value: string): void {
  try {
    window.localStorage.setItem(SEARCH_BACKEND_STORAGE_KEY, value);
  } catch {
    /* приватный режим — выбор останется только на время сессии */
  }
}

export const SearchSourcesBlock: React.FC = () => {
  const { t, locale } = useI18n();
  const [backends, setBackends] = useState<SearchBackendInfo[]>([]);
  const [verticals, setVerticals] = useState<SearchBackendInfo[]>([]);
  const [selected, setSelected] = useState<string>(() => readStoredBackend() ?? 'auto');
  const [loadError, setLoadError] = useState(false);
  const [serverWarning, setServerWarning] = useState(false);
  const [probe, setProbe] = useState<ProbeMessage | null>(null);
  const [probing, setProbing] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [outcome, setOutcome] = useState<SearchMessage | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await fetchSearchBackends();
      // The server lists the narrow verticals in a dedicated `verticals`
      // array (each `vertical: true`); api.ts does not declare that field yet,
      // so the catalog is widened structurally here.
      const catalog = payload as SearchBackendsPayload & { verticals?: SearchBackendInfo[] };
      const list = catalog.backends ?? [];
      const selectable = selectableBackends(list);
      setBackends(selectable);
      setVerticals(collectVerticals(list, catalog.verticals));
      setSelected((current) => resolveSelectedBackend(current, selectable, catalog.selected ?? null));
      setServerWarning(Boolean(catalog.warning));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = (value: string) => {
    setSelected(value);
    writeStoredBackend(value);
    setProbe(null);
    setOutcome(null);
  };

  const runProbe = async () => {
    if (!isProbeable(selected)) return;
    setProbing(true);
    try {
      const result = await probeSearchBackend(selected);
      const level = result.level ?? (result.ok ? 'ok' : 'error');
      setProbe({
        tone: probeOutcomeTone(level),
        key: probeOutcomeKey(level),
        latencyMs: result.latencyMs,
      });
    } catch {
      setProbe({ tone: 'error', key: probeOutcomeKey('error') });
    } finally {
      setProbing(false);
    }
  };

  const runSearch = async () => {
    const text = query.trim();
    if (!text) {
      setOutcome({ tone: 'warning', key: 'searchSources.result.emptyQuery', count: 0, items: [] });
      return;
    }
    setSearching(true);
    try {
      const payload = await searchWeb({ query: text, backend: selected, limit: 3, lang: locale });
      const items = payload.results ?? [];
      const reason = payload.reason ?? null;
      setOutcome({
        tone: searchOutcomeTone(reason, items.length),
        key: searchOutcomeKey(reason, items.length),
        count: items.length,
        items,
        fallbackBackend: payload.backend && payload.backend !== selected ? payload.backend : null,
      });
    } catch {
      setOutcome({ tone: 'error', key: 'searchSources.result.failed', count: 0, items: [] });
    } finally {
      setSearching(false);
    }
  };

  const current = backends.find((backend) => backend.id === selected) ?? null;
  const state = current ? backendState(current) : null;
  const probeable = isProbeable(selected);

  return (
    <details className="search-sources">
      <summary>
        <ChevronRight size={16} strokeWidth={1.5} className="search-sources__chevron" aria-hidden="true" />
        {t('searchSources.title')}
      </summary>
      <div className="stack">
        <p className="caption">{t('searchSources.summary')}</p>
        {loadError ? <p className="error-text">{t('searchSources.loadError')}</p> : null}
        {serverWarning ? <p className="caption">{t('searchSources.serverWarning')}</p> : null}
        <p className="caption search-sources__serper-hint">{t('searchSources.serperHint')}</p>

        <div className="field">
          <label className="field__label" htmlFor="search-source-select">
            {t('searchSources.backendLabel')}
          </label>
          <select
            id="search-source-select"
            className="select"
            value={selected}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="auto">{t('searchSources.backend.auto')}</option>
            {backends.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {t(backendLabelKey(backend.id))}
              </option>
            ))}
          </select>
        </div>

        {state ? (
          <p className="meta">
            {t(`searchSources.state.${state}`)}
            {current?.envKey ? ` · ${current.envKey}` : ''}
          </p>
        ) : null}

        {verticals.length > 0 ? (
          <div className="search-sources__verticals">
            <p className="field__label">{t('searchSources.verticals.title')}</p>
            <p className="caption">{t('searchSources.verticals.caption')}</p>
            <ul className="search-sources__vertical-list">
              {verticals.map((vertical) => (
                <li key={vertical.id} className="search-sources__vertical" title={vertical.id}>
                  <span className="search-sources__vertical-name">{t(backendLabelKey(vertical.id))}</span>
                  <span className="meta">
                    {t('searchSources.vertical.keyless')} · {t('searchSources.vertical.byTopic')}
                  </span>
                  <span className="meta search-sources__vertical-desc">
                    {t(`searchSources.backend.${vertical.id}.description`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {probeable ? (
          <div className="button-row">
            <button className="button" disabled={probing} onClick={() => void runProbe()}>
              {probing ? t('searchSources.probing') : t('searchSources.probe')}
            </button>
          </div>
        ) : null}
        {probe ? (
          <p className={probe.tone === 'error' ? 'error-text' : 'caption'}>
            {t(probe.key)}
            {probe.latencyMs !== undefined ? ` · ${probe.latencyMs} ms` : ''}
          </p>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="search-source-query">
            {t('searchSources.queryLabel')}
          </label>
          <input
            id="search-source-query"
            className="input"
            value={query}
            placeholder={t('searchSources.queryPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="button-row">
          <button className="button button--primary" disabled={searching} onClick={() => void runSearch()}>
            {searching ? t('searchSources.searching') : t('searchSources.search')}
          </button>
        </div>

        {outcome ? (
          <p className={outcome.tone === 'error' ? 'error-text' : 'caption'}>
            {t(outcome.key, { count: outcome.count })}
          </p>
        ) : null}
        {outcome?.fallbackBackend ? (
          <p className="caption">
            {t('searchSources.fallback', { backend: t(backendLabelKey(outcome.fallbackBackend)) })}
          </p>
        ) : null}
        {outcome && outcome.items.length > 0 ? (
          <ul className="search-sources__results">
            {outcome.items.map((item, index) => {
              // Per-item `provider` (D42) is attributed via the dictionary
              // label; the raw id is exposed only as a title, never as text.
              const providerId = resultProviderId(item as SearchResultItem & { provider?: string | null });
              const providerKey = providerLabelKey(providerId);
              const providerLabel = providerKey ? t(providerKey) : null;
              const showProvider = providerLabel !== null && providerLabel !== providerKey;
              return (
                <li key={`${item.url ?? 'result'}-${index}`}>
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.title || item.url}
                  </a>
                  {showProvider ? (
                    <span className="meta search-sources__provider" title={providerId ?? undefined}>
                      {providerLabel}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        <p className="meta">{t('searchSources.hint')}</p>
      </div>
    </details>
  );
};
