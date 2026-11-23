import { useEffect, useRef, useState } from 'react';
import { apiGet } from './useApi';
import { tr } from '../i18n/runtime';
import { normalizeProgressStatus, type ProgressStatus } from './progressStatus';

// Тип статуса живёт в progressStatus.ts (там же — нормализация «сырых»
// статусов БД вроде needs_review), но реэкспортируется отсюда: прежний
// публичный путь импорта не должен ломаться.
export type { ProgressStatus };

export interface ProgressPayload {
  type: string;
  articleId: string;
  currentStage: number;
  totalStages: number;
  stageName: string;
  agentName: string;
  description: string;
  percent: number;
  status: ProgressStatus;
  // Optional message carried by the HTTP /progress endpoint. WS payloads omit it,
  // but we keep it optional so both sources feed the same shape.
  message?: string;
}

export interface UseWebSocketProgressResult {
  progress: ProgressPayload | null;
  error: string | null;
}

/**
 * Stage 2: terminal status set across BOTH sources.
 * WS sends: completed / error / stopped / needs-review.
 * HTTP /progress sends: ready / published (terminal-success), failed (terminal-error), stopped.
 * Once any of these is reached we stop polling and allow the WS to close.
 */
const TERMINAL_STATUSES: ReadonlySet<ProgressStatus> = new Set<ProgressStatus>([
  'completed',
  'error',
  'stopped',
  'needs-review',
  'ready',
  'published',
  'failed',
]);

function isTerminalStatus(status: ProgressStatus | string | undefined): boolean {
  return !!status && (TERMINAL_STATUSES as Set<string>).has(status);
}

/**
 * Shape returned by GET /api/articles/:id/progress.
 * Envelope is { success, data: {...} }.
 */
interface ProgressResponse {
  success?: boolean;
  data?: {
    status?: string;
    currentStage?: number;
    totalStages?: number;
    stageName?: string;
    agentName?: string;
    description?: string;
    percent?: number;
    message?: string;
  };
}

const POLL_INTERVAL_MS = 3000;

export function useWebSocketProgress(articleId: string | null): UseWebSocketProgressResult {
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reconnectCountRef = useRef(0);
  // Terminal statuses: once reached, the stream is allowed to close and we must
  // NOT surface a "connection lost" error over an already-final result.
  const terminalReachedRef = useRef(false);
  // Track the current articleId in a ref so onclose can tell stale closures
  // apart from a real re-subscription.
  const articleIdRef = useRef(articleId);

  useEffect(() => {
    if (!articleId) {
      terminalReachedRef.current = false;
      return;
    }
    terminalReachedRef.current = false;
    articleIdRef.current = articleId;
    const activeArticleId = articleId;

    // ------------------------------------------------------------------
    // WebSocket (primary, real-time)
    // ------------------------------------------------------------------
    const WS_BASE = import.meta.env.VITE_WS_BASE_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
    const ws = new WebSocket(`${WS_BASE}/ws`);

    ws.onopen = () => {
      reconnectCountRef.current = 0;
      // Only clear the error if we are still on the same article subscription.
      if (articleIdRef.current === activeArticleId) {
        setError(null);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Partial<ProgressPayload>;
        if (data.type === 'article-progress' && data.articleId === activeArticleId) {
          // WS-кадр и REST-статус приводятся к одному словарю (needs_review
          // из БД → needs-review), иначе финал не считается терминальным.
          const status = normalizeProgressStatus(data.status);
          // Bug fix: a valid progress message means the stream is healthy —
          // clear any stale error from a previous transient onerror/onclose.
          // Without this, a single reconnect blip leaves "connection lost"
          // displayed permanently even while progress updates keep flowing.
          if (status === 'running' || status === 'needs-review') {
            setError(null);
          }
          // WS is real-time and authoritative — it always wins over polling.
          setProgress({ ...data, status } as ProgressPayload);
          if (isTerminalStatus(status)) {
            terminalReachedRef.current = true;
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      if (articleIdRef.current === activeArticleId && !terminalReachedRef.current) {
        setError(tr('errors.progressConnect'));
      }
    };

    ws.onclose = (event) => {
      // After a terminal status the server is expected to close the socket;
      // that is normal and must not mask the final (often green) result with a
      // spurious "Соединение прервано" error.
      if (terminalReachedRef.current) {
        return;
      }
      if (!event.wasClean && articleIdRef.current === activeArticleId) {
        setError(tr('errors.progressClosed'));
      }
    };

    // ------------------------------------------------------------------
    // HTTP polling fallback (Stage 2)
    // ------------------------------------------------------------------
    // Covers: F5 (WS not yet connected), WS drops, dev/prod environment
    // differences. Polls GET /api/articles/:id/progress every POLL_INTERVAL_MS.
    // WS payloads always take precedence — polling only fills gaps when WS has
    // not delivered a fresher update. We achieve "WS wins" by stamping each
    // accepted poll update with the moment it was applied and discarding it
    // the next time a WS message arrives.
    //
    // Implementation note: rather than try to compare timestamps from two
    // different clocks, we simply let WS overwrite unconditionally (see
    // onmessage above). Polling writes are only applied if the WS has not
    // already pushed a terminal result, which is the only case where the two
    // sources could disagree about a final state.
    let cancelled = false;

    const poll = async () => {
      if (cancelled || articleIdRef.current !== activeArticleId) return;
      if (terminalReachedRef.current) return; // WS (or a prior poll) already finalized
      try {
        const res = await apiGet<ProgressResponse>(
          `/api/articles/${activeArticleId}/progress`,
        );
        if (cancelled || articleIdRef.current !== activeArticleId) return;
        const data = res?.data;
        if (!data) return;
        // REST отдаёт СЫРОЙ статус статьи из БД ('needs_review'), клиент ждёт
        // 'needs-review' — без нормализации финал не распознаётся и опрос
        // /progress продолжается каждые 3 секунды.
        const status = normalizeProgressStatus(data.status);
        const payload: ProgressPayload = {
          type: 'article-progress',
          articleId: activeArticleId,
          currentStage: data.currentStage ?? 0,
          totalStages: data.totalStages ?? 11,
          stageName: data.stageName ?? '',
          agentName: data.agentName ?? 'system',
          description: data.description ?? data.stageName ?? '',
          percent: data.percent ?? 0,
          status,
          message: data.message,
        };
        // Polling complements, never overrides, a live WS terminal result.
        if (!terminalReachedRef.current) {
          setProgress(payload);
        }
        if (isTerminalStatus(status)) {
          terminalReachedRef.current = true;
        }
      } catch {
        // Polling errors are silent — WS error path already surfaces a message,
        // and transient 5xx/network blips on the polling endpoint must not
        // mask an otherwise-healthy stream.
      }
    };

    // Kick the first poll immediately so an F5 recovers progress before the
    // first 3s tick, then repeat on the interval. setInterval is cleared on
    // teardown; per-call guards (cancelled / terminalReachedRef) make a poll
    // a no-op once we are done.
    void poll();
    const pollTimer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

    return () => {
      // Mark as a deliberate close so onclose does not fire a stale error
      // when React tears down the socket on unmount / articleId change.
      cancelled = true;
      clearInterval(pollTimer);
      terminalReachedRef.current = true;
      ws.close();
    };
  }, [articleId]);

  return { progress, error };
}
