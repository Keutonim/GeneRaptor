/**
 * W «Автоматизация» (2026-10-27): единый источник литерала статуса ручной
 * публикации и матрицы доступа к ней.
 *
 * Контракт:
 *   - Ручная отметка пишет Article.status = 'published_manual' (R7).
 *   - D8-инвариант сохраняется: статус 'published' пишет РОВНО ОДИН роут —
 *     Rentry (server/routes/articles.mjs, rentry-обработчик). Этот модуль
 *     'published' НИКОГДА не возвращает как результат записи и не включает
 *     его в разрешённые исходные статусы.
 *   - 'published_manual' — ТЕРМИНАЛЬНЫЙ статус (воркер не перегенерирует,
 *     очередь его исключает, История показывает).
 *
 * Импортируется воркером и server/lib/article-progress.mjs.
 */

/** Статус Article.status после ручной отметки «опубликовано». */
export const MANUAL_PUBLISH_STATUS = 'published_manual';

/**
 * Исходные статусы, из которых разрешена ручная отметка (gate 6).
 * 'published' (Rentry) — запрещён: отметка затёрла бы факт rentry-публикации.
 */
export const MANUAL_PUBLISH_ALLOWED_STATUSES = ['ready', 'needs_review', 'review'];

/** Значение Publication.status для записи о ручной публикации (не 'pending'). */
export const PUBLICATION_STATUS_MANUAL = 'published_manual';

/** Терминальные статусы (истина для воркера и article-progress). */
const TERMINAL_STATUSES = ['needs_review', 'ready', 'completed', 'published', MANUAL_PUBLISH_STATUS];

/**
 * Терминален ли статус статьи (воркер не перегенерирует, прогресс = 100).
 * @param {string|null|undefined} status — Article.status.
 * @returns {boolean}
 */
export function isFinalStatus(status) {
  return typeof status === 'string' && TERMINAL_STATUSES.includes(status);
}
