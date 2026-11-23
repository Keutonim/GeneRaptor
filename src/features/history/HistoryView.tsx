/**
 * M6 — вкладка «История».
 *
 * Список прошлых статей: тема, статус-словом, объём и дата моноширинным.
 * В меню строки — открыть, копирование, скачивание обложки и удаление.
 *
 * Меню строки — попап-карточка (не колонка в потоке), подтверждение
 * удаления — непрозрачный диалог отдельным слоем (ConfirmDialog).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FolderOpen, ImageDown, Info, MoreHorizontal, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { copyToClipboard } from '../../lib/clipboard';
import { coverDownloadMessage, downloadCover } from '../../lib/export/coverDownload';
import { ArticleDetailsModal } from '../../components/ArticleDetailsModal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { exportPayload, type ExportFormat } from '../shared/exportContent';
import { deleteArticle, fetchArticles, fetchContent, type ArticleSummary } from '../generation/api';
import { ApiError } from '../../hooks/useApi';
import { filterArticles, formatChars, formatDate, statusWord } from './helpers/historyRows';

export interface HistoryViewProps {
  /** Открыть статью — вызывается с идентификатором. */
  onOpen: (articleId: string) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({ onOpen }) => {
  const { t } = useI18n();
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<{ id: string; message: string } | null>(null);
  /** Ошибка удаления живёт РЯДОМ с действием (в строке), не в шапке. */
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  /** Идём запрос удаления — кнопка заблокирована (один DELETE на клик). */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** 404 «уже удалена» — нейтральное сообщение, не красная ошибка. */
  const [deleteGone, setDeleteGone] = useState<string | null>(null);
  const deletingRef = useRef<string | null>(null);
  /** M8: модалка «Сведения» открывается из меню строки истории. */
  const [detailsId, setDetailsId] = useState<string | null>(null);
  /** Кнопка-триггер меню строки — на неё возвращается фокус. */
  const menuRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  /** Строка, чьё подтверждение удаления было открыто (для фокуса). */
  const confirmTriggerId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchArticles();
        if (!cancelled) setArticles(items);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('errors.load'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** Закрытое подтверждение возвращает фокус на кнопку меню строки. */
  useEffect(() => {
    if (confirmDelete !== null) return;
    const id = confirmTriggerId.current;
    confirmTriggerId.current = null;
    if (!id) return;
    menuRefs.current[id]?.focus();
  }, [confirmDelete]);

  /** Открытое меню закрывается кликом вне — попап не лежит на странице. */
  useEffect(() => {
    if (!openMenu) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && typeof target.closest === 'function') {
        if (target.closest('.history__actions') || target.closest('.history__menu')) return;
      }
      setOpenMenu(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [openMenu]);

  const visible = useMemo(
    () =>
      filterArticles(articles, query).filter(
        (article) => status === 'all' || statusWord(article.status) === status,
      ),
    [articles, query, status],
  );

  const copy = useCallback(
    async (articleId: string, format: ExportFormat) => {
      try {
        const content = await fetchContent(articleId);
        await copyToClipboard(exportPayload(content, format));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('errors.load'));
      }
    },
    [t],
  );

  /** M8: обложка скачивается файлом; 404/503 показываются переводимой строкой. */
  const download = useCallback(
    async (articleId: string) => {
      try {
        await downloadCover(articleId);
        setCoverError(null);
      } catch (cause) {
        setCoverError({ id: articleId, message: coverDownloadMessage(cause, t) });
      }
    },
    [t],
  );

  const remove = useCallback(async (articleId: string) => {
    // Защита от двойного клика — ровно один DELETE на подтверждение.
    if (deletingRef.current) return;
    deletingRef.current = articleId;
    setDeletingId(articleId);
    setDeleteGone(null);
    try {
      await deleteArticle(articleId);
      setArticles((current) => current.filter((article) => article.id !== articleId));
      setConfirmDelete(null);
      setDeleteError(null);
    } catch (cause) {
      // Подтверждение не «залипает»; обратная связь — у действия.
      setConfirmDelete(null);
      if (cause instanceof ApiError && cause.status === 404) {
        // Уже удалена (повторный клик / другая вкладка) — нейтрально.
        setArticles((current) => current.filter((article) => article.id !== articleId));
        setDeleteError(null);
        setDeleteGone(t('history.deleteGone'));
      } else {
        setDeleteError({
          id: articleId,
          message: cause instanceof Error ? cause.message : t('errors.load'),
        });
      }
    } finally {
      deletingRef.current = null;
      setDeletingId(null);
    }
  }, [t]);

  return (
    <section className="history">
      <h2 className="page-title">{t('history.title')}</h2>

      <div className="history__filters">
        <input
          id="history-filter"
          className="input"
          type="search"
          placeholder={t('history.filter.topic')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          id="history-status"
          className="select"
          aria-label={t('history.filter.status')}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">{t('history.filter.all')}</option>
          <option value="ready">{t('status.ready')}</option>
          <option value="running">{t('status.running')}</option>
          <option value="error">{t('status.error')}</option>
          <option value="stopped">{t('status.stopped')}</option>
          <option value="review">{t('status.review')}</option>
        </select>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {deleteGone ? <p className="caption">{deleteGone}</p> : null}
      {visible.length === 0 ? <p className="caption">{t('history.empty')}</p> : null}

      <ul className="history__rows">
        {visible.map((article) => (
          <li key={article.id} className="history__row">
            <button
              type="button"
              className="history__menu"
              data-testid="history-delete-menu"
              aria-label={t('history.more')}
              aria-expanded={openMenu === article.id}
              ref={(node) => {
                menuRefs.current[article.id] = node;
              }}
              onClick={() => setOpenMenu(openMenu === article.id ? null : article.id)}
              onKeyDown={(event) => {
                // Escape closes the row menu, the focus stays on the trigger.
                if (event.key === 'Escape' && openMenu === article.id) {
                  event.preventDefault();
                  setOpenMenu(null);
                }
              }}
            >
              <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>

            <div className="history__topic">{article.topic}</div>
            <span className="caption history__status">{t(`status.${statusWord(article.status)}`)}</span>
            <span className="meta history__volume">{formatChars(article.targetLength)}</span>
            <span className="meta history__date">{formatDate(article.createdAt)}</span>

            {openMenu === article.id ? (
              <div
                className="history__actions"
                role="menu"
                aria-label={t('history.more')}
                onKeyDown={(event) => {
                  // Escape from any menu item closes the menu and
                  // returns the focus to the trigger button.
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenMenu(null);
                    menuRefs.current[article.id]?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="button"
                  onClick={() => {
                    setOpenMenu(null);
                    onOpen(article.id);
                  }}
                >
                  <FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.open')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="button"
                  onClick={() => {
                    setOpenMenu(null);
                    setDetailsId(article.id);
                  }}
                >
                  <Info size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.details')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="button"
                  onClick={() => void copy(article.id, 'html')}
                >
                  <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.copyHtml')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="button"
                  onClick={() => void copy(article.id, 'text')}
                >
                  <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.copyText')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="button"
                  onClick={() => void copy(article.id, 'markdown')}
                >
                  <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.copyMarkdown')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="button"
                  onClick={() => void download(article.id)}
                >
                  <ImageDown size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.downloadCover')}
                </button>
                <div className="history__actions__separator" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="button button--danger"
                  onClick={() => {
                    // Открытие подтверждения закрывает меню — иначе
                    // две интерактивные панели накладываются друг на друга.
                    setOpenMenu(null);
                    setDeleteError(null);
                    confirmTriggerId.current = article.id;
                    setConfirmDelete(article.id);
                  }}
                >
                  <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t('history.delete')}
                </button>
              </div>
            ) : null}

              {coverError?.id === article.id ? (
                <p className="error-text">{coverError.message}</p>
              ) : null}

              {confirmDelete === article.id ? (
                <ConfirmDialog
                  className="history__confirm"
                  testId="history-delete-confirm"
                  confirmTestId="history-delete-button"
                  title={t('history.deleteTitle')}
                  text={t('history.deleteText', { topic: article.topic })}
                  confirmLabel={t('history.deleteConfirmAction')}
                  cancelLabel={t('history.cancel')}
                  busy={deletingId === article.id}
                  onConfirm={() => void remove(article.id)}
                  onCancel={() => {
                    setConfirmDelete(null);
                    setDeleteError(null);
                  }}
                />
            ) : null}

              {deleteError?.id === article.id ? (
                <p className="error-text" data-testid="history-delete-error">
                  {deleteError.message}
                </p>
              ) : null}
          </li>
        ))}
      </ul>

      <ArticleDetailsModal articleId={detailsId} onClose={() => setDetailsId(null)} />
    </section>
  );
};
