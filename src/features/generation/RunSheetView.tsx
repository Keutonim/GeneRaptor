/**
 * M6 — лист хода генерации (состояние C).
 *
 * Одиннадцать строк по ролям, слева вертикальная линейка, у текущего этапа
 * слово-статус. Длительности сервер не отдаёт — показываем номер этапа.
 */
import React from 'react';
import { agentRoles } from '../../data/agentRoles';
import { useI18n } from '../../i18n';
import { buildRunSheet } from './helpers/runSheet';

export interface RunSheetViewProps {
  currentStage: number;
  totalStages?: number;
  stageName?: string | null;
  agentName?: string | null;
  description?: string | null;
  busy?: boolean;
  onStop?: () => void;
}

export const RunSheetView: React.FC<RunSheetViewProps> = ({
  currentStage,
  totalStages = agentRoles.length,
  stageName = null,
  agentName = null,
  description = null,
  busy = false,
  onStop,
}) => {
  const { t } = useI18n();
  const rows = buildRunSheet(agentRoles, currentStage);

  return (
    <section className="run-sheet panel">
      <h2 className="page-title">{t('run.title')}</h2>

      <p className="meta" aria-live="polite">
        {t('run.stage', { current: Math.min(Math.max(currentStage, 0), totalStages), total: totalStages })}
        {stageName ? ` · ${stageName}` : ''}
        {agentName ? ` · ${agentName}` : ''}
      </p>
      {description ? <p className="caption">{description}</p> : null}

      <ol className="run-sheet__list">
        {rows.map((row) => (
          <li
            key={row.roleId}
            className={`run-sheet__row run-sheet__row--${row.state}`}
            data-state={row.state}
          >
            <span className="meta">{row.index}</span>
            <span className="run-sheet__name">{row.name}</span>
            <span className="run-sheet__state">
              {row.state === 'done'
                ? t('run.done')
                : row.state === 'current'
                  ? t('run.current')
                  : t('run.pending')}
            </span>
          </li>
        ))}
      </ol>

      {onStop ? (
        <div className="button-row">
          <button type="button" className="button" disabled={busy} onClick={onStop}>
            {t('run.stop')}
          </button>
        </div>
      ) : null}
    </section>
  );
};
