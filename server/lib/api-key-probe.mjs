/**
 * Проба API-ключей провайдеров (волна 1, B3).
 *
 * Назначение: дать владельцу ЧЕСТНЫЙ ответ «работает ключ или нет», а не
 * имитацию вида «длина строки > 10» (старая кнопка «Проверить подключение»
 * проверяла локальное поле, а реальные ключи живут в env сервера).
 *
 * Безопасность:
 *   - ключ передаётся ТОЛЬКО в заголовке Authorization;
 *   - значение ключа (и его фрагменты) никогда не попадают в результат,
 *     в Error.message и в лог;
 *   - текст ответа провайдера в сообщение НЕ включается (только HTTP-код и
 *     собственный текст сервиса) — в теле провайдера может быть эхо запроса;
 *   - НЕТ ретраев: одна попытка на шаг (проверка должна быть быстрой);
 *   - есть таймаут через AbortController.
 *
 * fetch внедряется (`fetchImpl`) — это делает функцию чистой и позволяет
 * тестировать её без реальной сети.
 *
 * SEC-02: адрес провайдера проверяется тем же политическим модулем, что и
 * остальные исходящие вызовы (server/lib/provider-url.mjs).
 */

import { resolveProbeEndpoint } from './provider-url.mjs';
import { SERPER_ENDPOINT, TAVILY_ENDPOINT } from './web-search/endpoints.mjs';

const ROUTERAI_DEFAULT_ENDPOINT = 'https://routerai.ru/api/v1';
const ROUTERAI_DEFAULT_MODEL = 'qwen/qwen3.6-flash';
const YANDEX_SEARCH_DEFAULT_ENDPOINT =
  'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync';

/** Короткий запрос для пробы Yandex Search (минимум трафика). */
const YANDEX_PROBE_QUERY = 'тест';

/** Короткий запрос для пробы Serper.dev (минимум трафика). */
const SERPER_PROBE_QUERY = 'test';

/** Короткий запрос для пробы Tavily (минимум трафика). */
const TAVILY_PROBE_QUERY = 'test';

/**
 * Уровни результата пробы (в возвращаемом объекте — поле `level`):
 *   ok      — ключ принят провайдером;
 *   warning — подтвердить не удалось (ключ не задан / лимит частоты / сеть / 5xx);
 *   error   — ключ отвергнут провайдером (401/403).
 * «Ключ не задан» — это НЕ «ключ сломан»: поэтому warning, а не error.
 *
 * Список уровней отдельной константой не выносится: он нигде не
 * перечисляется поимённо, а сами значения раздают функции ниже
 * (networkFailure/keyMissing → warning, isAuthFailure → error, успех → ok).
 */

/**
 * Тот же предикат, что в server/routes/health.mjs (isConfigured):
 * значение есть, это строка и это не placeholder из .env.example.
 *
 * Дублирование — намеренное: health.mjs тянет Prisma/Redis, а эта либа
 * должна оставаться чистой (юнит-тесты без БД).
 */
export function isApiKeyConfigured(value) {
  if (!value || typeof value !== 'string') return false;
  return !/^put_.*_here$|^change_me|^your_.*$/.test(value.trim());
}

/** Убирает хвостовые слэши у эндпоинта, чтобы URL собирался без двойных //. */
function normalizeEndpoint(endpoint) {
  return String(endpoint || '').replace(/\/+$/, '');
}

/**
 * Один HTTP-запрос с таймаутом. Возвращает только HTTP-статус и текст
 * (текст НЕ попадает в сообщение пробы — он нужен лишь для диагностики).
 */
async function request(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    let text = '';
    try {
      text = typeof res.text === 'function' ? await res.text() : '';
    } catch {
      text = '';
    }
    return {
      status: Number(res.status) || 0,
      ok: Boolean(res.ok),
      text: typeof text === 'string' ? text : '',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Единый ответ на сетевую ошибку/таймаут — без деталей провайдера. */
function networkFailure() {
  return {
    ok: false,
    level: 'warning',
    message: 'Проверка не прошла: нет связи с провайдером',
    latencyMs: 0,
  };
}

/** Ключ не задан на сервере — сети не касаемся вообще. */
function keyMissing() {
  return {
    ok: false,
    level: 'warning',
    message: 'Ключ не настроен на сервере',
    latencyMs: 0,
  };
}

function isAuthFailure(status) {
  return status === 401 || status === 403;
}

/**
 * Проба ключа RouterAI — тонкая обёртка над probeOpenAICompatible (M3):
 * эндпоинт/модель по-прежнему из env (ROUTERAI_ENDPOINT /
 * ROUTERAI_MODEL_STANDARD), сообщения и уровни идентичны волне 1.
 */
export async function probeRouterAiKey(apiKey, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return probeOpenAICompatible(apiKey, {
    baseUrl: process.env.ROUTERAI_ENDPOINT || ROUTERAI_DEFAULT_ENDPOINT,
    fetchImpl,
    timeoutMs,
    label: 'RouterAI',
    fallbackModel: process.env.ROUTERAI_MODEL_STANDARD || ROUTERAI_DEFAULT_MODEL,
  });
}

/**
 * Универсальная проба OpenAI-совместимого провайдера (M3).
 *
 * Два режима:
 *   - проба ключа (model не задан): GET {baseUrl}/models; на 404/405 фолбэк
 *     POST {baseUrl}/chat/completions c max_tokens:1 и fallbackModel —
 *     семантика probeRouterAiKey волны 1, параметризованная baseUrl;
 *   - проба модели (model задан): ОДИН запрос POST chat/completions с этим
 *     model id — «пингануть выбранную модель» (M3 AC).
 *
 * keyOptional (ollama): проба идёт и без ключа — заголовок Authorization
 * не отправляется. Для key-required провайдеров без ключа — warning без
 * сети. Значение ключа никогда не попадает в результат.
 *
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {string} opts.baseUrl — базовый URL провайдера (без /chat/completions).
 * @param {string} [opts.model] — «пинг этой модели» (явный id модели).
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.keyOptional]
 * @param {string} [opts.label] — имя провайдера для сообщений.
 * @param {string} [opts.fallbackModel] — модель фолбэк-чата пробы ключа.
 * @returns {Promise<{ok: boolean, level: string, message: string, latencyMs: number, statusCode?: number}>}
 */
export async function probeOpenAICompatible(
  apiKey,
  {
    baseUrl,
    model,
    fetchImpl = fetch,
    timeoutMs = 15000,
    keyOptional = false,
    label = 'провайдер',
    fallbackModel,
    kind,
    endpointSource = 'canonical',
  } = {},
) {
  const hasKey = Boolean(apiKey && typeof apiKey === 'string' && apiKey.trim());
  if (!hasKey && !keyOptional) {
    return keyMissing();
  }

  const startedAt = Date.now();
  // SEC-02: the probe target goes through the SAME endpoint policy as every
  // other outbound call — a stored (user-supplied) URL is validated against
  // the private-network rules, an operator endpoint is checked structurally.
  const requested = normalizeEndpoint(baseUrl);
  const endpoint = await resolveProbeEndpoint({
    kind,
    baseUrl: requested || ROUTERAI_DEFAULT_ENDPOINT,
    endpointSource: requested ? endpointSource : 'canonical',
  });
  const headers = hasKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const okResult = (message, status) => ({
    ok: true,
    level: 'ok',
    message,
    latencyMs: Date.now() - startedAt,
    statusCode: status,
  });
  const errorResult = (status) => ({
    ok: false,
    level: 'error',
    message: `Ключ отклонён ${label} (HTTP ${status})`,
    latencyMs: Date.now() - startedAt,
    statusCode: status,
  });
  const rateResult = (status) => ({
    ok: false,
    level: 'warning',
    message: `Ключ действителен, но ${label} временно ограничил частоту запросов — попробуйте позже.`,
    latencyMs: Date.now() - startedAt,
    statusCode: status,
  });
  const warnResult = (status) => ({
    ok: false,
    level: 'warning',
    message: `Проверка не прошла: ${label} вернул HTTP ${status}`,
    latencyMs: Date.now() - startedAt,
    statusCode: status,
  });

  const chatProbe = async (modelId) =>
    request(
      fetchImpl,
      `${endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      },
      timeoutMs,
    );

  try {
    // ── Проба модели: один чат-комплишн с выбранным id (M3 AC). ──
    if (model) {
      const chat = await chatProbe(model);
      if (chat.ok) {
        return okResult(`Ключ и модель «${model}» приняты (${label})`, chat.status);
      }
      if (isAuthFailure(chat.status)) return errorResult(chat.status);
      if (chat.status === 429) return rateResult(chat.status);
      return warnResult(chat.status);
    }

    // ── Проба ключа: GET /models → фолбэк-чат (семантика волны 1). ──
    const models = await request(fetchImpl, `${endpoint}/models`, { method: 'GET', headers }, timeoutMs);

    if (models.ok) {
      return okResult(hasKey ? `Ключ принят ${label}` : `Провайдер ${label} доступен (ключ не требуется)`, models.status);
    }

    if (isAuthFailure(models.status)) return errorResult(models.status);
    if (models.status === 429) return rateResult(models.status);

    // 404/405 — эндпоинт не поддерживает /models: пробуем чат-комплишн.
    if (models.status === 404 || models.status === 405) {
      const chat = await chatProbe(fallbackModel || ROUTERAI_DEFAULT_MODEL);
      if (chat.ok) {
        return okResult(hasKey ? `Ключ принят ${label}` : `Провайдер ${label} доступен (ключ не требуется)`, chat.status);
      }
      if (isAuthFailure(chat.status)) return errorResult(chat.status);
      if (chat.status === 429) return rateResult(chat.status);
      return warnResult(chat.status);
    }

    return warnResult(models.status);
  } catch {
    // Таймаут или обрыв связи — детали провайдера сюда не попадают.
    return { ...networkFailure(), latencyMs: Date.now() - startedAt };
  }
}

/**
 * Проба ключа Yandex Search API.
 *
 * Тело запроса — ТОЧНО та же структурированная форма, что и в
 * server/lib/yandex-search.mjs (плоская форма {"query":"..."} даёт 400
 * «proto: syntax error» — это ошибка формы, а не ключа).
 *
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, level: string, message: string, latencyMs: number, statusCode?: number}>}
 */
export async function probeYandexSearchKey(apiKey, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return keyMissing();
  }

  const startedAt = Date.now();
  const endpoint = normalizeEndpoint(
    process.env.YANDEX_SEARCH_ENDPOINT || YANDEX_SEARCH_DEFAULT_ENDPOINT,
  );

  try {
    const res = await request(
      fetchImpl,
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        body: JSON.stringify({
          query: {
            searchType: 'SEARCH_TYPE_RU',
            queryText: YANDEX_PROBE_QUERY,
            page: '0',
          },
          responseFormat: 'FORMAT_HTML',
          region: '213',
          groupSpec: {
            groupMode: 'GROUP_MODE_FLAT',
            groupsOnPage: '50',
            docsInGroup: '1',
          },
        }),
      },
      timeoutMs,
    );

    if (res.ok) {
      return {
        ok: true,
        level: 'ok',
        message: 'Ключ принят Yandex Search API',
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    if (isAuthFailure(res.status)) {
      return {
        ok: false,
        level: 'error',
        message: `Ключ отклонён Yandex Search API (HTTP ${res.status})`,
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    if (res.status === 429) {
      // Ключ принят, но поиск временно ограничен по частоте запросов.
      return {
        ok: false,
        level: 'warning',
        message: 'Ключ действителен, но поиск временно ограничен по частоте запросов — попробуйте позже.',
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    // 400 и прочие — детали ответа провайдера не раскрываем (там может быть
    // эхо запроса и внутренние коды).
    return {
      ok: false,
      level: 'warning',
      message: `Проверка не прошла: Yandex Search API вернул HTTP ${res.status}`,
      latencyMs: Date.now() - startedAt,
      statusCode: res.status,
    };
  } catch {
    return { ...networkFailure(), latencyMs: Date.now() - startedAt };
  }
}

/**
 * Проба ключа Serper.dev — поисковый backend web-search слоя.
 *
 * D27/D28: ключ уходит ТОЛЬКО на канонический endpoint Serper.dev. Адрес
 * провайдера здесь не настраивается пользователем, поэтому «чужой» endpoint
 * технически недостижим: ключ физически не может уйти на сторонний URL.
 */
export async function probeSerperSearchKey(apiKey, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return keyMissing();
  }

  const startedAt = Date.now();

  let endpoint;
  try {
    endpoint = await resolveProbeEndpoint({
      kind: 'serper',
      baseUrl: SERPER_ENDPOINT,
      endpointSource: 'canonical',
    });
  } catch {
    return { ...networkFailure(), latencyMs: Date.now() - startedAt };
  }

  try {
    const res = await request(
      fetchImpl,
      endpoint,
      {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: SERPER_PROBE_QUERY, num: 1 }),
      },
      timeoutMs,
    );

    if (res.ok) {
      return {
        ok: true,
        level: 'ok',
        message: 'Ключ принят Serper.dev',
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    if (isAuthFailure(res.status)) {
      return {
        ok: false,
        level: 'error',
        message: `Ключ отклонён Serper.dev (HTTP ${res.status})`,
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    if (res.status === 429 || res.status === 402) {
      // 429 — the rate limit of the tier; 402 — the credit balance of the
      // account is spent. Both mean "the key works, the quota is gone".
      return {
        ok: false,
        level: 'warning',
        code: 'quota_exhausted',
        message:
          res.status === 402
            ? 'Ключ действителен, но баланс кредитов Serper.dev исчерпан.'
            : 'Ключ действителен, но лимит запросов Serper.dev исчерпан.',
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    return {
      ok: false,
      level: 'warning',
      message: `Проверка не прошла: Serper.dev вернул HTTP ${res.status}`,
      latencyMs: Date.now() - startedAt,
      statusCode: res.status,
    };
  } catch {
    return { ...networkFailure(), latencyMs: Date.now() - startedAt };
  }
}

/**
 * Probe the Tavily search key (keyed mode).
 *
 * The key travels only to the canonical Tavily endpoint (SEC-02) and never
 * appears in the result.
 *
 * @param {string} apiKey
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 */
export async function probeTavilySearchKey(apiKey, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return keyMissing();
  }

  const startedAt = Date.now();

  let endpoint;
  try {
    endpoint = await resolveProbeEndpoint({
      kind: 'tavily',
      baseUrl: TAVILY_ENDPOINT,
      endpointSource: 'canonical',
    });
  } catch {
    return { ...networkFailure(), latencyMs: Date.now() - startedAt };
  }

  try {
    const res = await request(
      fetchImpl,
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: TAVILY_PROBE_QUERY, max_results: 1 }),
      },
      timeoutMs,
    );

    if (res.ok) {
      return {
        ok: true,
        level: 'ok',
        message: 'Ключ принят Tavily',
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    if (isAuthFailure(res.status)) {
      return {
        ok: false,
        level: 'error',
        message: `Ключ отклонён Tavily (HTTP ${res.status})`,
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    if (res.status === 429 || res.status === 402) {
      // 429 — the rate limit of the tier; 402 — the credit balance of the
      // account is spent. Both mean "the key works, the quota is gone".
      return {
        ok: false,
        level: 'warning',
        code: 'quota_exhausted',
        message:
          res.status === 402
            ? 'Ключ действителен, но баланс кредитов Tavily исчерпан.'
            : 'Ключ действителен, но лимит запросов Tavily исчерпан.',
        latencyMs: Date.now() - startedAt,
        statusCode: res.status,
      };
    }

    return {
      ok: false,
      level: 'warning',
      message: `Проверка не прошла: Tavily вернул HTTP ${res.status}`,
      latencyMs: Date.now() - startedAt,
      statusCode: res.status,
    };
  } catch {
    return { ...networkFailure(), latencyMs: Date.now() - startedAt };
  }
}
