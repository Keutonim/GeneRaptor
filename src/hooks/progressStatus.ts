/**
 * Единый словарь статусов прогресса для клиента (hardening, H-06).
 *
 * Источники статуса разные и пишут его по-разному:
 *   - WS-кадры воркера: 'running' | 'completed' | 'error' | 'stopped';
 *   - REST /api/articles/:id/progress и GET /api/articles/:id: СЫРОЙ статус
 *     статьи из БД — 'needs_review' (с подчёркиванием), 'ready', 'published',
 *     'failed';
 *   - сам клиент для 'needs_review' использует 'needs-review' (с дефисом).
 *
 * Если не нормализовать, финальный статус 'needs_review' не попадает в
 * терминальные → UI не переключается на статью и продолжает опрос /progress
 * каждые 3 секунды (бесконечный поллинг).
 */

/** Статусы прогресса, которые понимает клиент. */
export type ProgressStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'needs-review'
  // Stage 2: statuses surfaced only by the HTTP-polling fallback (DB statuses).
  // They map onto the same union so the UI can react uniformly. `ready`/`published`
  // are terminal-success (article finished), `failed` is terminal-error.
  | 'ready'
  | 'published'
  | 'failed';

/** Сырые статусы статьи из БД → статусы прогресса клиента. */
const RAW_STATUS_ALIASES: Record<string, ProgressStatus> = {
  needs_review: 'needs-review',
};

/**
 * Приводит статус (из БД, REST или WS) к статусу прогресса клиента.
 *
 * @param raw — исходный статус; пустое/неизвестное значение → 'running'.
 */
export function normalizeProgressStatus(raw: string | null | undefined): ProgressStatus {
  if (typeof raw !== 'string' || raw === '') return 'running';
  const alias = RAW_STATUS_ALIASES[raw];
  if (alias) return alias;
  return raw as ProgressStatus;
}
