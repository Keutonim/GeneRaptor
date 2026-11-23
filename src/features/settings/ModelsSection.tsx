/**
 * M6 — раздел «Модели».
 *
 * Таблица: уровень → модель → сколько ролей на уровне → замена модели.
 * Уровни и их роли считаются по локальному каталогу ролей (server/agent-role-data.mjs),
 * сами модели приходят с сервера (M3) — сервер остаётся источником правды.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { agentRoles } from '../../data/agentRoles';
import { useI18n } from '../../i18n';
import { fetchCoverSettings, fetchProviderModels, fetchProviders, saveProvider } from './api';
import { buildModelRows, roleCountsByTier, type ProviderCard } from './helpers/models';

export interface ModelsSectionProps {
  /**
   * Bumped by SettingsView after the cover panel saves — the derived
   * cover row re-reads cover_settings.model so the two views never diverge.
   */
  coverRefreshToken?: number;
}

export const ModelsSection: React.FC<ModelsSectionProps> = ({ coverRefreshToken = 0 }) => {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [catalogue, setCatalogue] = useState<Record<string, string[]>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * cover_settings.model — the single applied cover model. The cover
   * row below is a read-only derivative of it; null (not loaded / failed)
   * means no cover row rather than a diverging provider-tier pin.
   */
  const [coverModel, setCoverModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchProviders();
        if (cancelled) return;
        setProviders(list);
        setError(null);
        const kinds = Array.from(new Set(list.filter((p) => p.enabled).map((p) => p.kind)));
        const entries = await Promise.all(
          kinds.map(async (kind) => {
            try {
              return [kind, await fetchProviderModels(kind)] as const;
            } catch {
              return [kind, [] as string[]] as const;
            }
          }),
        );
        if (!cancelled) setCatalogue(Object.fromEntries(entries));
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('errors.load'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await fetchCoverSettings();
        if (!cancelled) setCoverModel(typeof settings.model === 'string' ? settings.model : null);
      } catch {
        // Honest degradation: no cover row when the settings cannot be read.
        if (!cancelled) setCoverModel(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coverRefreshToken]);

  const rows = useMemo(
    () => buildModelRows(providers, roleCountsByTier(agentRoles), coverModel),
    [providers, coverModel],
  );

  const apply = async (providerKind: string, tier: string, model: string) => {
    const provider = providers.find((p) => p.kind === providerKind);
    if (!provider) return;
    try {
      await saveProvider(providerKind, { models: { ...provider.models, [tier]: model } });
      setNotice(t('models.applied'));
      const list = await fetchProviders();
      setProviders(list);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.generic'));
    }
  };

  return (
    <div className="stack">
      {error ? <p className="error-text">{error}</p> : null}
      {notice ? <p className="caption">{notice}</p> : null}

      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('models.level')}</th>
            <th scope="col">{t('models.model')}</th>
            <th scope="col">{t('models.roles')}</th>
            <th scope="col">{t('models.replace')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const options = catalogue[row.providerKind] ?? [];
            const current = selections[row.tier] ?? row.model;
            const choices = options.length ? options : row.model ? [row.model] : [];
            return (
              <tr key={row.tier}>
                <td>{t(`models.level.${row.tier}`)}</td>
                <td>
                  <span className="meta">{row.model || '—'}</span>
                  <span className="meta"> · {row.provider}</span>
                </td>
                <td>{row.roles}</td>
                <td>
                  {row.derived ? (
                    // The cover model is managed in the Cover section —
                    // a read-only derivative here, never a second choice.
                    <span className="caption">{t('models.cover.derived')}</span>
                  ) : (
                    <div className="button-row">
                      <select
                        className="select"
                        aria-label={`${t('models.replace')} · ${t(`models.level.${row.tier}`)}`}
                        value={current}
                        onChange={(event) =>
                          setSelections((prev) => ({ ...prev, [row.tier]: event.target.value }))
                        }
                      >
                        {choices.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button"
                        disabled={!current || current === row.model}
                        onClick={() => void apply(row.providerKind, row.tier, current)}
                      >
                        {t('models.apply')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
