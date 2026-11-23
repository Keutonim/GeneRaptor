/**
 * M6 — панель обложки в результате.
 *
 * Состояния: не запрашивалась / генерируется / готова / ошибка / пропущена.
 * Действия: сгенерировать, перегенерировать по уточнению, сгенерировать
 * заново, скачать обложку.
 */
import React, { useEffect, useState } from 'react';
import { coverErrorMessage } from '../../data/cover';
import { useI18n } from '../../i18n';
import { coverDownloadMessage, downloadCover } from '../../lib/export/coverDownload';
import { requestCover } from './api';

/** Сервер ограничивает уточнение 500 символами (REFINEMENT_MAX). */
export const REFINEMENT_MAX = 500;

export interface CoverPanelProps {
  articleId: string;
  /** Имя файла обложки (M5); байты отдаёт GET /api/articles/:id/cover. */
  coverFile: string | null;
  /** Причина недоступности обложки от сервера (M5). */
  coverUnavailableReason?: string | null;
  coverModel?: string | null;
  coverCostRub?: number | null;
  coverGeneratedAt?: string | null;
  coverStatus?: string | null;
  coverSkipReason?: string | null;
  coverAvailable?: boolean;
  onUpdated?: () => void;
}

export const CoverPanel: React.FC<CoverPanelProps> = ({
  articleId,
  coverFile,
  coverUnavailableReason = null,
  coverModel = null,
  coverCostRub = null,
  coverGeneratedAt = null,
  coverStatus = null,
  coverSkipReason = null,
  coverAvailable = true,
  onUpdated,
}) => {
  const { t } = useI18n();
  const [refinement, setRefinement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const isGenerating = coverStatus === 'generating';
  const isReady =
    coverStatus === 'ready' || (Boolean(coverFile) && coverStatus !== 'failed');
  const coverSrc = `/api/articles/${articleId}/cover`;

  useEffect(() => {
    if (!isGenerating) return undefined;
    const timer = setInterval(() => onUpdated?.(), 5000);
    return () => clearInterval(timer);
  }, [isGenerating, onUpdated]);

  const run = async (body: { refinement?: string; fresh?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await requestCover(articleId, body);
      setRefinement('');
      onUpdated?.();
    } catch (cause) {
      setError(coverErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /** M8: обложка скачивается файлом (fetch → blob → файл), 404/503 не роняют панель. */
  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadCover(articleId);
    } catch (cause) {
      setDownloadError(coverDownloadMessage(cause, t));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="cover-panel panel">
      <h3 className="section-title">{t('cover.title')}</h3>

      {isGenerating ? (
        <div className="cover-plate">
          <p className="caption">{t('cover.generating')}</p>
        </div>
      ) : null}

      {!isGenerating && isReady ? (
        <>
          <div className="cover-plate">
            <img src={coverSrc} alt={t('cover.title')} />
          </div>
          <p className="meta">
            {t('cover.caption', {
              model: coverModel ?? '—',
              cost: coverCostRub === null || coverCostRub === undefined ? '—' : String(coverCostRub),
            })}
          </p>
        </>
      ) : null}

      {!isGenerating && !isReady && coverStatus === 'failed' ? (
        <div className="cover-plate">
          <p className="error-text">{t('cover.failed')}</p>
        </div>
      ) : null}

      {!isGenerating && !isReady && coverStatus === 'skipped' ? (
        <div className="cover-plate">
          <p className="caption">{t('cover.skipped')}</p>
          {coverSkipReason ? <p className="meta">{coverSkipReason}</p> : null}
        </div>
      ) : null}

      {!isGenerating && !isReady && !coverStatus ? (
        <div className="cover-plate">
          <p className="caption">{t('cover.notRequested')}</p>
        </div>
      ) : null}

      {!coverAvailable ? <p className="caption">{t('cover.unavailable')}</p> : null}
      {coverUnavailableReason ? (
        <p className="meta">{coverUnavailableReason}</p>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
      {downloadError ? <p className="error-text">{downloadError}</p> : null}

      <div className="field">
        <label className="field__label" htmlFor="cover-refinement">
          {t('cover.refine.label')}
        </label>
        <textarea
          id="cover-refinement"
          className="textarea"
          maxLength={REFINEMENT_MAX}
          placeholder={t('cover.refine.placeholder')}
          value={refinement}
          onChange={(event) => setRefinement(event.target.value)}
        />
      </div>

      <div className="button-row">
        {isReady ? (
          <>
            <button
              type="button"
              className="button"
              disabled={busy || !refinement.trim()}
              onClick={() => void run({ refinement: refinement.trim() })}
            >
              {t('cover.refine')}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void run({ fresh: true })}
            >
              {t('cover.fresh')}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || downloading}
              onClick={() => void download()}
            >
              {downloading ? t('cover.downloading') : t('cover.download')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--primary"
            disabled={busy || !coverAvailable}
            onClick={() => void run({})}
          >
            {t('cover.generate')}
          </button>
        )}
      </div>
    </section>
  );
};
