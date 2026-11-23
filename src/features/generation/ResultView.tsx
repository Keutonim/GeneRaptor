/**
 * M6 — результат генерации (состояние D).
 *
 * Полоса набора (гали) со статьёй и правая колонка с панелью обложки и
 * действиями экспорта. HTML статьи санитайзится DOMPurify.
 */
import React, { useCallback, useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { useI18n } from '../../i18n';
import { useArticleExport } from '../shared/useArticleExport';
import { fetchContent, type ArticleContent, type MaterialLanguage } from './api';
import { CoverPanel } from './CoverPanel';

export interface ResultViewProps {
  articleId: string;
  language?: MaterialLanguage;
  stages?: number;
  onContentChanged?: () => void;
}

export const ResultView: React.FC<ResultViewProps> = ({
  articleId,
  language = 'ru',
  stages = 11,
  onContentChanged,
}) => {
  const { t } = useI18n();
  const [content, setContent] = useState<ArticleContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportActions = useArticleExport(content);

  const load = useCallback(async () => {
    try {
      const data = await fetchContent(articleId);
      setContent(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('errors.load'));
    }
  }, [articleId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const words = content?.characterCount
    ? Math.round(content.characterCount / 6)
    : 0;

  return (
    <section className="result">
      <div className="galley">
        {error ? <p className="error-text">{error}</p> : null}
        {content ? (
          <>
            <h1 className="page-title">{content.h1 || content.title}</h1>
            <p className="meta">
              {t('article.meta', {
                words: t('article.words', { count: words }),
                stages: t('article.stages', { count: stages }),
                language: t(language === 'en' ? 'language.en' : 'language.ru'),
              })}
            </p>
            <div
              className="galley__body"
              // HTML приходит с сервера и очищается перед вставкой в DOM.
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.contentHtml ?? '') }}
            />
          </>
        ) : null}
      </div>

      <aside className="result__rail">
        <CoverPanel
          articleId={articleId}
          coverFile={content?.coverFile ?? null}
          coverUnavailableReason={content?.coverUnavailableReason ?? null}
          coverModel={content?.coverModel ?? null}
          coverCostRub={content?.coverCostRub ?? null}
          coverGeneratedAt={content?.coverGeneratedAt ?? null}
          coverStatus={content?.coverStatus ?? null}
          coverSkipReason={content?.coverSkipReason ?? null}
          coverAvailable={content?.coverAvailable ?? false}
          onUpdated={() => {
            void load();
            onContentChanged?.();
          }}
        />

        <section className="panel">
          <h3 className="section-title">{t('export.title')}</h3>
          <div className="button-row">
            <button type="button" className="button" onClick={() => void exportActions.copy('html')}>
              {exportActions.copied === 'html' ? t('export.copied') : t('history.copyHtml')}
            </button>
            <button type="button" className="button" onClick={() => void exportActions.copy('text')}>
              {exportActions.copied === 'text' ? t('export.copied') : t('history.copyText')}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void exportActions.copy('markdown')}
            >
              {exportActions.copied === 'markdown' ? t('export.copied') : t('history.copyMarkdown')}
            </button>
          </div>
        </section>
      </aside>
    </section>
  );
};
