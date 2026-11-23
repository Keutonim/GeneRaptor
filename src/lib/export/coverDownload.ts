/**
 * M8 — скачивание обложки статьи файлом.
 *
 * GET /api/articles/:id/cover отдаёт бинарник. Обычная ссылка с атрибутом
 * download сохраняет файл под именем маршрута, поэтому байты забираются
 * blob-ом и отдаются браузеру через object URL с осмысленным именем.
 *
 * Ошибки сервера (404 / 400 / 503) не роняют интерфейс: они приходят
 * машинным кодом, который UI переводит через словарь.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type Translate = (key: string) => string;

/**
 * Ошибка скачивания обложки: машинный код из ответа сервера + HTTP-статус.
 * Модуль не зависит от API-слоя — бинарник забирается напрямую.
 */
export class CoverDownloadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CoverDownloadError';
    this.code = code;
    this.status = status;
  }
}

export interface CoverDownloadOptions {
  /** Подмена fetch — для тестов. */
  fetchImpl?: FetchLike;
}

/** Путь бинарника обложки. */
export function coverPath(articleId: string): string {
  return `/api/articles/${articleId}/cover`;
}

/** Имя файла обложки: cover-<articleId>.png. */
export function coverFilename(articleId: string): string {
  return `cover-${articleId}.png`;
}

/** Код ошибки по статусу, если тело ответа не JSON. */
function fallbackCode(status: number): string {
  if (status === 404) return 'cover_not_found';
  if (status === 400) return 'cover_invalid_article_id';
  if (status === 503) return 'cover_not_configured';
  return 'cover_unavailable';
}

/** Ошибка ответа сервера → CoverDownloadError с машинным кодом. */
async function readFailure(response: Response): Promise<CoverDownloadError> {
  let code = '';
  let message = '';
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown } | null;
    if (body && typeof body.code === 'string') code = body.code;
    if (body && typeof body.error === 'string') message = body.error;
  } catch {
    // Тело не JSON — код берём по статусу.
  }
  const resolved = code || fallbackCode(response.status);
  return new CoverDownloadError(resolved, message || resolved, response.status);
}

/** Байты обложки статьи. */
export async function fetchCoverBlob(
  articleId: string,
  fetchImpl?: FetchLike,
): Promise<Blob> {
  const request: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const response = await request(coverPath(articleId));
  if (!response.ok) throw await readFailure(response);
  return await response.blob();
}

/** Скачать обложку статьи как файл. */
export async function downloadCover(
  articleId: string,
  options: CoverDownloadOptions = {},
): Promise<void> {
  const blob = await fetchCoverBlob(articleId, options.fetchImpl);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = coverFilename(articleId);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // object URL освобождаем позже: синхронный revoke в том же тике, что и
    // click(), отменяет загрузку файла в Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Сообщение об ошибке скачивания — из словаря (RU/EN). */
export function coverDownloadMessage(cause: unknown, t: Translate): string {
  const code = cause instanceof CoverDownloadError ? cause.code : undefined;
  if (code === 'cover_not_found') return t('cover.notFound');
  return t('cover.downloadError');
}
