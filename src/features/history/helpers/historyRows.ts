/**
 * M6 — pure helpers of the History tab.
 *
 * The status is rendered as a word, never as a coloured pill; the volume and
 * the date are rendered monospaced. The topic filter runs on the client.
 */

export type HistoryStatusKey = 'ready' | 'error' | 'stopped' | 'running' | 'review';

const STATUS_WORDS: Record<string, HistoryStatusKey> = {
  completed: 'ready',
  ready: 'ready',
  published: 'ready',
  failed: 'error',
  error: 'error',
  stopped: 'stopped',
  running: 'running',
  queued: 'running',
  pending: 'running',
  'needs-review': 'review',
  'needs_review': 'review',
};

/** Unknown statuses fall back to «требует проверки» instead of breaking the row. */
export function statusWord(status: string | null | undefined): HistoryStatusKey {
  if (!status) return 'review';
  return STATUS_WORDS[status] ?? 'review';
}

/** 65000 → «65 000» with a non-breaking space (monospaced volume). */
export function formatChars(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  const groups = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${sign}${groups}`;
}

/** ISO date → «ДД.ММ.ГГГГ»; a broken date prints «—». */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const year = String(parsed.getFullYear());
  return `${day}.${month}.${year}`;
}

/** Client-side topic filter (case-insensitive substring). */
export function filterArticles<T extends { topic?: string | null }>(items: T[], query: string): T[] {
  const list = Array.isArray(items) ? items : [];
  const needle = (query ?? '').trim().toLowerCase();
  if (!needle) return list;
  return list.filter((item) => (item.topic ?? '').toLowerCase().includes(needle));
}
