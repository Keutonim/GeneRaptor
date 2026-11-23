/**
 * M6 — API-слой генерации.
 *
 * Сервер отвечает конвертом `{ success: true, data: … }`, поэтому `unwrap`
 * снимает конверт. Сервер — источник правды: и статья, и её содержимое,
 * и обложка читаются с сервера.
 */
import { apiDelete, apiGet, apiPost, apiPut } from '../../hooks/useApi';
import { tr } from '../../i18n/runtime';

export type MaterialLanguage = 'ru' | 'en';

export interface ArticleSummary {
  id: string;
  topic: string;
  status: string;
  targetLength: number;
  language: MaterialLanguage;
  userNotes?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  coverStatus?: string | null;
  coverSkipReason?: string | null;
  progress?: number | null;
}

export interface ArticleContent {
  title: string;
  description: string;
  h1: string;
  contentHtml: string;
  contentText: string;
  contentMarkdown: string;
  characterCount: number;
  /** Имя файла обложки в локальном хранилище (M5); байты — GET /api/articles/:id/cover. */
  coverFile: string | null;
  /** Причина недоступности обложки от сервера (M5). */
  coverUnavailableReason: string | null;
  coverModel: string | null;
  coverCostRub: number | null;
  coverGeneratedAt: string | null;
  coverStatus: string | null;
  coverSkipReason: string | null;
  coverAvailable: boolean;
}

export interface CoverActionResult {
  coverFile?: string | null;
  model?: string | null;
  costRub?: number | null;
  warnings?: string[];
}

function unwrap<T>(raw: unknown): T | undefined {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    return (raw as { data?: T }).data;
  }
  return raw as T | undefined;
}

/** Создать статью. `language` — D6 (язык материала), его принимает сервер. */
export async function createArticle(input: {
  topic: string;
  targetLength: number;
  userNotes?: string;
  language: MaterialLanguage;
  confirmConcatenatedTopic?: boolean;
}): Promise<ArticleSummary> {
  const raw = await apiPost<unknown>('/api/articles', input);
  const data = unwrap<ArticleSummary>(raw);
  if (!data?.id) throw new Error(tr('errors.articleCreate'));
  return data;
}

export async function startArticle(id: string, coverRequested: boolean): Promise<void> {
  await apiPost(`/api/articles/${id}/start`, { coverRequested });
}

export async function stopArticle(id: string): Promise<void> {
  await apiPost(`/api/articles/${id}/stop`, {});
}

export async function fetchArticle(id: string): Promise<ArticleSummary> {
  const raw = await apiGet<unknown>(`/api/articles/${id}`);
  const data = unwrap<ArticleSummary>(raw);
  if (!data) throw new Error(tr('errors.articleNotFound'));
  return data;
}

export async function fetchContent(id: string): Promise<ArticleContent> {
  const raw = await apiGet<unknown>(`/api/articles/${id}/content`);
  const data = unwrap<ArticleContent>(raw);
  if (!data) throw new Error(tr('errors.articleContentNotFound'));
  return data;
}

export async function saveContent(
  id: string,
  payload: { title: string; description: string; contentHtml: string },
): Promise<void> {
  await apiPut(`/api/articles/${id}/content`, payload);
}

export async function deleteArticle(id: string): Promise<void> {
  await apiDelete(`/api/articles/${id}`);
}

export async function fetchArticles(limit = 50, offset = 0): Promise<ArticleSummary[]> {
  const raw = await apiGet<unknown>(`/api/articles?limit=${limit}&offset=${offset}`);
  const data = unwrap<ArticleSummary[] | { items?: ArticleSummary[] }>(raw);
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}

/** Обложка: пустое тело — создать, refinement — уточнить, fresh — с нуля. */
export async function requestCover(
  id: string,
  body: { refinement?: string; fresh?: boolean } = {},
): Promise<CoverActionResult> {
  const raw = await apiPost<unknown>(`/api/articles/${id}/cover`, body);
  return unwrap<CoverActionResult>(raw) ?? {};
}
