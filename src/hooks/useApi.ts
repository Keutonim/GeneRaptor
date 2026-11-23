/**
 * Базовый HTTP-слой для фронтенда.
 *
 * Контракт (фиксирован интерфейсом):
 *  - Возвращает СЫРОЙ JSON тела ответа (НЕ разворачивает `data` —
 *    часть компонентов разворачивает его самостоятельно).
 *  - Использует relative URLs (`/api/...`) — Vite proxy резолвит хост.
 *    НЕ используем import.meta.env.VITE_API_BASE_URL.
 *  - Content-Type: application/json для POST/PUT.
 *
 * Edge-cases:
 *  - AbortError  → re-throw как есть (потребители проверяют err.name === 'AbortError').
 *  - 204         → return null (тело пустое, JSON не парсится).
 *  - TypeError   → throw new Error('Сервер недоступен').
 *  - не-2xx      → парсим тело ОБОИХ конвертов ошибки:
 *                  плоский {error:'строка', code?, suggestion?} и вложенный
 *                  {success:false, error:{code, message, suggestion?}} —
 *                  бросаем ApiError(message, code, suggestion, status).
 *                  Если тело не JSON / пустое — нейтральное локализованное
 *                  Error(tr('errors.httpStatus')), НЕ res.statusText.
 *
 * Access-gate (R-10): любой 401 вызывает зарегистрированный
 * `onUnauthorized`-коллбэк — App.tsx показывает TokenGate (сессия умерла).
 * Коллбэк вызывается ровно один раз на 401, до броска Error.
 */

import { tr } from '../i18n/runtime';
const JSON_HEADERS: HeadersInit = { 'Content-Type': 'application/json' };

/**
 * Глобальный обработчик 401. Регистрируется один раз из App.tsx.
 * `null` по умолчанию — если никто не подписался, поведение не меняется.
 */
let onUnauthorized: (() => void) | null = null;

/**
 * Подписка на 401-ответы. Возвращает функцию отписки.
 * Используется App.tsx для показа TokenGate когда сессия умерла.
 */
export function subscribeUnauthorized(handler: () => void): () => void {
  onUnauthorized = handler;
  return () => {
    if (onUnauthorized === handler) onUnauthorized = null;
  };
}

/**
 * ux-fixes U2: структурированная ошибка API. Бэк может отдавать в теле
 * ошибки машинный `code` и опционально `suggestion` (например, 400
 * code='topic_looks_like_concatenation' + suggestion-нормализация темы).
 * message — человекочитаемая строка из body.error / body.message (как было).
 * Потребители ветвятся через `err instanceof ApiError && err.code === '...'`.
 */
export class ApiError extends Error {
  /** Машинный код ошибки с бэка (напр. 'topic_looks_like_concatenation'). */
  readonly code?: string;
  /** Предложение сервера по исправлению (напр. нормализованная тема). */
  readonly suggestion?: string | null;
  /** HTTP-статус ответа — потребители ветвятся по нему (напр. 404). */
  readonly status?: number;

  constructor(message: string, code?: string, suggestion?: string | null, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.suggestion = suggestion ?? null;
    this.status = status;
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Abort должен дойти до потребителя в исходном виде.
    if (e instanceof Error && e.name === 'AbortError') {
      throw e;
    }
    // fetch кидает TypeError, когда сервер недоступен / сеть упала.
    if (e instanceof TypeError) {
      throw new Error(tr('errors.serverUnavailable'));
    }
    throw e;
  }

  // 204 No Content — тела нет, JSON не парсим.
  if (res.status === 204) {
    return null as unknown as T;
  }

  // Access-gate: 401 → кука протухла (или отсутствует). Сообщаем подписчикам,
  // чтобы они могли показать TokenGate. Не делаем это для auth-роутов (exchange)
  // чтобы не зациклиться (exchange вызывается из TokenGate и ожидает 401).
  if (res.status === 401 && onUnauthorized && !url.startsWith('/api/auth/')) {
    onUnauthorized();
  }

  if (!res.ok) {
    let serverMessage: string | null = null;
    // U2: структурные поля ошибки (code/suggestion) доживают до потребителя.
    let errorCode: string | undefined;
    let suggestion: string | null = null;
    try {
      const body = await res.json();
      if (body && typeof body === 'object') {
        // Сервер отдаёт два конверта ошибки — плоский
        // {error:'строка', code?, suggestion?} (articles/auth) и вложенный
        // {success:false, error:{code, message, suggestion?}} (providers).
        // Нормализуем оба к одним полям, не ломая плоских потребителей.
        const rawError = (body as { error?: unknown }).error;
        const nested =
          rawError && typeof rawError === 'object'
            ? (rawError as { message?: unknown; code?: unknown; suggestion?: unknown })
            : null;
        const candidate = nested
          ? nested.message
          : rawError ?? (body as { message?: unknown }).message;
        if (typeof candidate === 'string' && candidate.length > 0) {
          serverMessage = candidate;
        }
        const rawCode = nested ? nested.code : (body as { code?: unknown }).code;
        if (typeof rawCode === 'string' && rawCode.length > 0) errorCode = rawCode;
        const rawSuggestion = nested
          ? nested.suggestion
          : (body as { suggestion?: unknown }).suggestion;
        if (typeof rawSuggestion === 'string' && rawSuggestion.length > 0) {
          suggestion = rawSuggestion;
        }
      }
    } catch {
      // тело не JSON — нейтральный fallback ниже
    }
    // res.statusText («Bad Request») не объясняет причину и не
    // переводится — нейтральное локализованное сообщение со статусом.
    const fallbackMessage = tr('errors.httpStatus', { status: res.status });
    if (serverMessage != null || errorCode != null || suggestion != null) {
      throw new ApiError(serverMessage ?? fallbackMessage, errorCode, suggestion, res.status);
    }
    throw new Error(fallbackMessage);
  }

  return (await res.json()) as T;
}

function mergeHeaders(
  base: HeadersInit,
  extra: HeadersInit | undefined,
): HeadersInit {
  if (!extra) return base;
  return { ...base, ...(extra as Record<string, string>) };
}

/**
 * article-quality (типы под расширенные ответы):
 * новые поля, которые сервер начнёт отдавать в GET /api/articles и
 * GET /api/articles/:id/content. Старый сервер их НЕ отдаёт, поэтому все
 * поля optional — фронт обязан работать с ?? -фолбэками на старые поля
 * (hasFallback / contentText) до и после мержа backend-изменений.
 */

/**
 * Расширение элемента списка GET /api/articles.
 * - hasTemplateContent: true — статья сгенерирована по fallback-шаблону
 *   (более точный источник, чем старый probe-флаг hasFallback).
 * - generationStartedAt: ISO-timestamp старта генерации — опора для
 *   elapsed-таймера в очереди, чтобы после рефреша страницы отсчёт
 *   продолжался с правильного значения, а не с нуля.
 */
export interface ArticleListItemQualityFields {
  hasTemplateContent?: boolean;
  generationStartedAt?: string | null;
  /** generation-progress: реальный прогресс генерации 0–100 с бэка
   *  (100 = завершено). null/нет поля = неизвестно (старый сервер, error). */
  progress?: number | null;
  /** ux-fixes: реальная причина needs_review («Превышен бюджет
   *  времени генерации (25 мин)» / QC / качество). Приходит в списке
   *  GET /api/articles. null/нет поля = старый сервер — строка списка
   *  молчит, ⚠-маркер получает дефолтный title. */
  needsReviewReason?: string | null;
}

/**
 * Расширение ответа GET /api/articles/:id/content.
 * - contentMarkdown: markdown-источник статьи. null/отсутствует у старых
 *   статей (markdown не сохранялся) — UI дизейблит кнопку копирования
 *   markdown с подсказкой.
 */
export interface ArticleContentQualityFields {
  contentMarkdown?: string | null;
}

/* ── W3 (postcheck): типы под пост-проверку качества ──────────────────
 * Замороженный контракт Dev-A (server/lib/article-postcheck.mjs) через
 * GET /api/articles/:id/details. Список GET /api/articles postcheck-полей
 * НЕ несёт — чек-лист живёт только в детальной карточке. */

/** Одно правило отчёта пост-проверки.
 *  severity: 'blocker' | 'major' | 'minor';
 *  status: 'pass' | 'fail' | 'skipped'.
 *  details опционален (в текущем контракте — строка); тип unknown,
 *  рендер обязан гардить typeof === 'string'. */
export interface PostcheckRule {
  id: string;
  block: string;
  severity: 'blocker' | 'major' | 'minor';
  status: 'pass' | 'fail' | 'skipped';
  message: string;
  details?: unknown;
}

/** Полный отчёт пост-проверки из /details (нормализован бэком:
 *  rules — массив, summary пересчитан при отсутствии). checkedAt — ISO-время
 *  служебного рана, может быть null. */
export interface PostcheckReport {
  version: number;
  verdict: 'ok' | 'warn' | 'fail';
  rules: PostcheckRule[];
  summary: { pass: number; fail: number; skipped: number };
  checkedAt?: string | null;
}

/** Расширение ответа GET /api/articles/:id/details (аддитивно): старый
 *  сервер полей не отдаёт — все optional, UI работает через ?? null и
 *  показывает «Пост-проверка не проводилась». */
export interface ArticleDetailsPostcheckFields {
  postcheck?: PostcheckReport | null;
  /** Лёгкий вердикт для ветвления без разбора rules. */
  postcheckVerdict?: 'ok' | 'warn' | 'fail' | null;
  /** non-null только при verdict='fail' (причина из правил) либо при
   *  статусе статьи needs_review (QC-фолбэк «Требуется контроль качества»). */
  needsReviewReason?: string | null;
}

export async function apiGet<T>(url: string, init?: RequestInit): Promise<T> {
  return request<T>(url, {
    method: 'GET',
    ...init,
  });
}

export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export async function apiPut(
  url: string,
  body: unknown,
  init?: RequestInit,
): Promise<void> {
  await request<void>(url, {
    method: 'PUT',
    headers: mergeHeaders(JSON_HEADERS, init?.headers),
    body: JSON.stringify(body),
    ...init,
  });
}

/**
 * DELETE с разбором тела ответа — нужен там, где сервер отдаёт
 * подтверждение операции (например, сброс промпта агентской роли).
 * Тело запроса не требуется; onUnauthorized-логика и разбор ошибок — те же.
 */
export async function apiDelete<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  return request<T>(url, {
    method: 'DELETE',
    ...init,
  });
}
