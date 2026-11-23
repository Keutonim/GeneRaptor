/**
 * M6 — вкладка «Генерация».
 *
 * Конечный автомат: компоновер → лист хода → результат.
 * Уточнения к теме живут на главной форме — отдельного
 * шага «Уточнения» больше нет, путь один: тема → уточнения → генерация.
 * Язык материала (D6) уходит в POST /api/articles параметром `language`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useWebSocketProgress } from '../../hooks/useWebSocketProgress';
import { normalizeProgressStatus } from '../../hooks/progressStatus';
import { Composer, type ComposerDraft } from './Composer';
import { ResultView } from './ResultView';
import { RunSheetView } from './RunSheetView';
import {
  createArticle,
  fetchArticle,
  startArticle,
  stopArticle,
  type MaterialLanguage,
} from './api';

type Phase = 'composer' | 'running' | 'result';

/**
 * Статусы, при которых статья готова и её можно показать.
 * 'needs-review' — прогон завершён, но контент сохранён для ручной проверки:
 * статья существует, её надо показать (сырой 'needs_review' из БД
 * нормализуется в 'needs-review' через normalizeProgressStatus).
 */
const READY_STATUSES = new Set(['completed', 'ready', 'published', 'needs-review']);

export interface GenerationViewProps {
  /** Статья, открытая из «Истории». */
  articleId?: string | null;
  onArticleChange?: (articleId: string | null) => void;
}

export const GenerationView: React.FC<GenerationViewProps> = ({
  articleId = null,
  onArticleChange,
}) => {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('composer');
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [notes, setNotes] = useState('');
  const [activeId, setActiveId] = useState<string | null>(articleId);
  const [language, setLanguage] = useState<MaterialLanguage>('ru');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ message: string; suggestion?: string | null } | null>(
    null,
  );
  const [suggestedTopic, setSuggestedTopic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTopic, setConfirmTopic] = useState(false);

  const { progress } = useWebSocketProgress(phase === 'running' ? activeId : null);

  // Статья, запущенная из этого экрана: её статус мы уже знаем, повторный
  // GET /api/articles/:id только сбрасывал бы фазу «лист хода».
  const ownArticleIdRef = useRef<string | null>(null);

  // Открытие статьи из «Истории»: состояние определяется сервером.
  useEffect(() => {
    if (!articleId) {
      setActiveId(null);
      setPhase('composer');
      return undefined;
    }
    if (articleId === ownArticleIdRef.current) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const article = await fetchArticle(articleId);
        if (cancelled) return;
        setActiveId(article.id);
        setLanguage(article.language ?? 'ru');
        setPhase(READY_STATUSES.has(normalizeProgressStatus(article.status)) ? 'result' : 'running');
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('errors.load'));
          setPhase('composer');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [articleId, t]);

  // Прогресс дошёл до финала — показываем статью.
  useEffect(() => {
    if (phase !== 'running' || !progress) return;
    if (READY_STATUSES.has(normalizeProgressStatus(progress.status))) setPhase('result');
  }, [phase, progress]);

  const start = useCallback(
    async (force = false, nextDraft: ComposerDraft | null = null) => {
      // The composer submits and starts in one tick — the fresh draft
      // arrives as an argument (the state closure would still hold the old one).
      const activeDraft = nextDraft ?? draft;
      if (!activeDraft) return;
      setBusy(true);
      setError(null);
      try {
        const article = await createArticle({
          topic: activeDraft.topic,
          targetLength: activeDraft.targetLength,
          userNotes: notes.trim() ? notes.trim() : undefined,
          language: activeDraft.language,
          ...(force ? { confirmConcatenatedTopic: true } : {}),
        });
        await startArticle(article.id, activeDraft.coverRequested);
        setWarning(null);
        setSuggestedTopic(null);
        setConfirmTopic(false);
        // The notes field resets after a successful start.
        setNotes('');
        ownArticleIdRef.current = article.id;
        setActiveId(article.id);
        setLanguage(activeDraft.language);
        onArticleChange?.(article.id);
        setPhase('running');
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        const message = cause instanceof Error ? cause.message : t('errors.generic');
        if (code === 'topic_looks_like_concatenation') {
          setWarning({
            message,
            suggestion: (cause as { suggestion?: string })?.suggestion ?? null,
          });
          setPhase('composer');
        } else {
          setError(message);
        }
      } finally {
        setBusy(false);
      }
    },
    [draft, notes, onArticleChange, t],
  );

  const stop = useCallback(async () => {
    if (!activeId) return;
    setBusy(true);
    try {
      await stopArticle(activeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }, [activeId, t]);

  if (phase === 'result' && activeId) {
    return (
      <ResultView
        articleId={activeId}
        language={language}
        onContentChanged={() => setPhase('result')}
      />
    );
  }

  if (phase === 'running' && activeId) {
    return (
      <>
        {progress && !READY_STATUSES.has(progress.status) && progress.status !== 'running' ? (
          <p className="error-text">{t('status.' + progress.status)}</p>
        ) : null}
        <RunSheetView
          currentStage={progress?.currentStage ?? 0}
          totalStages={progress?.totalStages ?? 11}
          stageName={progress?.stageName ?? null}
          agentName={progress?.agentName ?? null}
          description={progress?.description ?? null}
          busy={busy}
          onStop={() => void stop()}
        />
      </>
    );
  }

  return (
    <Composer
      onNext={(next) => {
        // One path — the main form submits and starts generation
        // directly; the separate clarify step is gone.
        setDraft(next);
        setError(null);
        void start(confirmTopic, next);
      }}
      notes={notes}
      onNotesChange={setNotes}
      busy={busy}
      error={error}
      warning={warning}
      suggestedTopic={suggestedTopic}
      onUseSuggestion={(topic) => {
        setSuggestedTopic(topic);
        setWarning(null);
      }}
      onForceStart={() => {
        setConfirmTopic(true);
        void start(true);
      }}
    />
  );
};
