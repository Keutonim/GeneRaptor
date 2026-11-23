/**
 * Yandex Search API client (async/poll pattern).
 *
 * Port of yaposparser/yaps.py to Node.js ESM. The Yandex Search API works
 * asynchronously: you POST a search request and get back an operation id,
 * then poll that operation until `done === true`. The result is HTML of the
 * search results page, base64-encoded in `response.rawData`.
 *
 * Endpoints (override via env):
 *   YANDEX_SEARCH_ENDPOINT    default https://searchapi.api.cloud.yandex.net/v2/web/searchAsync
 *   YANDEX_OPERATION_ENDPOINT default https://operation.api.cloud.yandex.net/operations
 *
 * Auth: `Authorization: Api-Key ${process.env.YANDEX_SEARCH_API_KEY}`
 * The key is a SearchAPI key (prefix `AQVN`).
 */
import { load } from 'cheerio';
import { researchUserAgent } from './research-user-agent.mjs';

const SEARCH_ENDPOINT =
  process.env.YANDEX_SEARCH_ENDPOINT ||
  'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync';

const OPERATION_ENDPOINT =
  process.env.YANDEX_OPERATION_ENDPOINT ||
  'https://operation.api.cloud.yandex.net/operations';

const RESULTS_PER_PAGE = 50; // Max for HTML format (matches yaps.py)
const POLL_INTERVAL_MS = 200; // Between poll attempts (matches yaps.py POLL_INTERVAL)
const POLL_MAX_ATTEMPTS = 100; // ~20s per operation (matches yaps.py POLL_MAX_ATTEMPTS)
const REQUEST_TIMEOUT_MS = 30_000; // Per HTTP request (matches yaps.py timeout=30)

// Yandex-internal domains — filtered out so we return only organic external URLs.
const YANDEX_DOMAINS = ['yandex.', 'ya.ru', 'yastatic.', 'yabs.', 'mc.yandex', 'avatars.mds'];

/**
 * Retryable HTTP status codes: 429 (rate limit) and 5xx (server errors).
 * 4xx (other than 429) are NOT retried — client/authorisation errors.
 */
function isRetryableStatus(status) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

const RETRYABLE_NETWORK_ERRORS =
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|AbortError|network|terminated/i;

function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const message = err.message || String(err);
  return RETRYABLE_NETWORK_ERRORS.test(message);
}

/**
 * Exponential backoff with jitter (mirrors callRouterAI in agent-role-execution.mjs).
 * Base 1000ms × 2^attempt, cap 30s, plus 0–1000ms jitter to avoid thundering herd.
 */
function computeBackoffDelay(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  const jitter = Math.random() * 1000;
  return Math.round(base + jitter);
}

/**
 * Reads the Yandex Search API key.
 *
 * `GENERAPTOR_YANDEX_API_KEY` is the current name; `YANDEX_SEARCH_API_KEY` is
 * kept as a legacy fallback for existing deployments.
 *
 * @param {object} [env]
 * @returns {string|null} the key or null when it is missing / a placeholder
 */
export function getApiKey(env = process.env) {
  const raw = env?.GENERAPTOR_YANDEX_API_KEY || env?.YANDEX_SEARCH_API_KEY;
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (/^put_.*_here$/.test(key) || /^change_me$/i.test(key) || /^your_.*$/i.test(key)) return null;
  return key;
}

function isExternalUrl(href) {
  if (!href || typeof href !== 'string') return false;
  if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('/')) {
    return false;
  }
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (!host) return false;
    return !YANDEX_DOMAINS.some((yd) => host.includes(yd));
  } catch {
    return false;
  }
}

export function decodeBase64Html(raw) {
  return Buffer.from(raw, 'base64').toString('utf-8');
}

/**
 * Parse Yandex SERP HTML and extract organic results.
 *
 * Simplified port of parse_yandex_html (yaps.py:237): the VNL ad-filter
 * (feature == "Органика") is intentionally omitted. Instead we rely on the
 * standard `li.serp-item` (desktop) / `div[data-cid]` (mobile) containers and
 * extract { url, title, snippet } from the first external link + h2 + organic
 * content block within each item.
 *
 * @param {string} html
 * @returns {Array<{ url: string, title: string, snippet: string }>}
 */
export function parseYandexHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const $ = load(html);

  let items = $('li.serp-item');
  if (items.length === 0) {
    items = $('div[data-cid]');
  }

  const results = [];

  items.each((_, el) => {
    const $item = $(el);
    const h2 = $item.find('h2').first();
    if (h2.length === 0) return;

    let href = null;

    // Primary: first external <a> inside the h2's parent <a> or h2 itself.
    const parentA = h2.parent('a');
    if (parentA.length && isExternalUrl(parentA.attr('href'))) {
      href = parentA.attr('href');
    }
    if (!href) {
      const childA = h2.find('a[href]').first();
      if (childA.length && isExternalUrl(childA.attr('href'))) {
        href = childA.attr('href');
      }
    }
    // Fallback: any external <a> in the item.
    if (!href) {
      $item.find('a[href]').each((__, a) => {
        if (!href && isExternalUrl($(a).attr('href'))) {
          href = $(a).attr('href');
        }
      });
    }

    if (!href) return;

    const title = h2.text().trim();
    // Snippet: Yandex uses .TextContainer (desktop BEM) for the description text,
    // .Organic-Subtitle as a breadcrumb fallback. Try several selectors — Yandex
    // markup shifts between desktop/mobile/regions.
    const snippet =
      $item.find('.TextContainer').first().text().trim() ||
      $item.find('.OrganicText').first().text().trim() ||
      $item.find('.organic__content').first().text().trim() ||
      $item.find('.Organic-Subtitle').first().text().trim() ||
      '';

    results.push({ url: href, title, snippet });
  });

  return results;
}

/**
 * POST to the async search endpoint and return the operation id.
 *
 * Body mirrors yaps.py _start_search (lines 124-152): RU search type, HTML
 * response format, flat grouping (50 groups × 1 doc).
 *
 * Retries transient network/HTTP errors with exponential backoff (up to 4 retries).
 *
 * @param {{ query: string, page?: number|string, region?: string }} params
 * @returns {Promise<string>} operation id
 * @throws {Error} if the API key is not configured or the request fails.
 */
export async function startYandexSearch({ query, page = 0, region = '213', apiKey: apiKeyOverride, fetchImpl }) {
  const apiKey = apiKeyOverride || getApiKey();
  if (!apiKey) {
    throw new Error('Yandex Search API key не настроен (GENERAPTOR_YANDEX_API_KEY).');
  }
  const doFetch = fetchImpl || globalThis.fetch;

  const body = {
    query: {
      searchType: 'SEARCH_TYPE_RU',
      queryText: query,
      page: String(page),
    },
    responseFormat: 'FORMAT_HTML',
    region: String(region),
    groupSpec: {
      groupMode: 'GROUP_MODE_FLAT',
      groupsOnPage: String(RESULTS_PER_PAGE),
      docsInGroup: '1',
    },
  };

  const maxRetries = 4;
  const maxAttempts = maxRetries + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'User-Agent': FETCH_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${response.status}`;
        throw new Error(`Yandex Search API error: ${msg}`);
      }

      const operationId = data?.id;
      if (!operationId) {
        throw new Error('Yandex Search API вернул ответ без operation id.');
      }
      return operationId;
    } catch (err) {
      lastError = err;
      if (!isRetryableNetworkError(err)) throw err;
      if (attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Yandex Search API: не удалось запустить поиск.');
}

/**
 * Poll an operation once. Mirrors yaps.py _check_operation (lines 154-174).
 *
 * @param {string} operationId
 * @returns {Promise<{ done: boolean, results?: Array, error?: string }>}
 */
export async function pollYandexOperation(operationId, { apiKey: apiKeyOverride, fetchImpl } = {}) {
  const apiKey = apiKeyOverride || getApiKey();
  if (!apiKey) {
    return { done: true, error: 'Yandex Search API key не настроен.' };
  }
  const doFetch = fetchImpl || globalThis.fetch;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await doFetch(`${OPERATION_ENDPOINT}/${operationId}`, {
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'User-Agent': FETCH_USER_AGENT,
      },
      signal: controller.signal,
    });

    // 404 = operation not ready/not found yet → keep polling.
    if (response.status === 404) {
      return { done: false };
    }

    if (!response.ok) {
      return { done: true, error: `Yandex Operation API error: HTTP ${response.status}` };
    }

    const data = await response.json();

    if (data.done) {
      const raw = data?.response?.rawData;
      if (!raw) {
        return { done: true, results: [], error: data?.error?.message };
      }
      const html = decodeBase64Html(raw);
      return { done: true, results: parseYandexHtml(html) };
    }

    return { done: false };
  } catch (err) {
    // Transient poll errors → treat as not-done so the loop continues.
    if (isRetryableNetworkError(err)) {
      return { done: false };
    }
    return { done: true, error: err.message || String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Full search cycle: start → poll until done → return parsed results.
 *
 * Mirrors yaps.py fetch_search_html (lines 187-192) + _poll_result (177-184),
 * but returns parsed `{ url, title, snippet }` objects instead of raw HTML.
 *
 * @param {{ query: string, page?: number|string, region?: string, maxAttempts?: number, intervalMs?: number }} params
 * @returns {Promise<{ results: Array<{url,title,snippet}>, totalOperations: number, elapsedMs: number }>}
 */
const FETCH_PAGE_TIMEOUT_MS = 15_000; // Абсолютный потолок на чтение одной страницы
const FETCH_PAGE_MAX_RETRIES = 2; // transient-ошибки при скрейпинге внешних сайтов
const FETCH_DEFAULT_MAX_CHARS = 2000; // truncate порог извлечённого текста
const FETCH_USER_AGENT = researchUserAgent('research evidence gathering');
const SUMMARY_MODEL =
  process.env.ROUTERAI_MODEL_STANDARD || 'deepseek-v3.2';

/**
 * Простой GET HTML c retry по тем же правилам, что и startYandexSearch.
 *
 * Возвращает единый объект `{ ok, status, html, error }` — форма ответа
 * фиксирована, чтобы вызывающий код не гадал о ней. НЕ зависит от DRY_RUN:
 * страница запрашивается по-настоящему, mock-HTML «Организация» не подставляется
 * (для скрейпинга произвольных SERP-URL mock сломал бы evidence-слой).
 *
 * @param {string} url
 * @param {{ timeout?: number, maxRetries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, html: string, error: string|null }>}
 */
export async function fetchWithRetry(url, opts = {}) {
  const timeout = opts.timeout || FETCH_PAGE_TIMEOUT_MS;
  const maxAttempts = (opts.maxRetries ?? FETCH_PAGE_MAX_RETRIES) + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': FETCH_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        signal: controller.signal,
      });

      const html = await response.text();

      // Retryable HTTP (429/5xx) — повторяем; прочие отдаём как есть.
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        html,
        error: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (err) {
      lastError = err;
      // Несетевые ошибки не ретраим — сразу отдаём результат.
      if (!isRetryableNetworkError(err)) {
        return { ok: false, status: 0, html: '', error: err.message || String(err) };
      }
      if (attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    ok: false,
    status: 0,
    html: '',
    error: lastError ? lastError.message || String(lastError) : 'fetch failed',
  };
}

/**
 * Достать plain-text контент из сообщения RouterAI (OpenAI-совместимый формат).
 * callRouterAI возвращает { status, data } где data.choices[0].message.content
 * может быть строкой или массивом частей (content-parts).
 */
function extractRouterContent(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join(' ')
      .trim();
  }
  if (typeof message.text === 'string') return message.text.trim();
  return '';
}

/**
 * AI-суммаризация извлечённого текста в 1 параграф (3-5 предложений) про услугу.
 * @param {Function} callRouterAI — из agent-role-execution.mjs
 * @param {string} text
 * @returns {Promise<string>} сводка (пустая строка при неудаче)
 */
async function summarizeWithAI(callRouterAI, text) {
  const payload = {
    model: SUMMARY_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Ты — редактор текстов. Делай точные краткие выжимки без выдумок.',
      },
      {
        role: 'user',
        content: `Сделай краткую выжимку (3-5 предложений) главного по теме из текста: ${text}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 500,
  };

  const { status, data } = await callRouterAI(payload);
  if (status < 200 || status >= 300) return '';
  const choice = Array.isArray(data?.choices) && data.choices.length ? data.choices[0] : null;
  const message = choice?.message ?? choice;
  return extractRouterContent(message);
}

/**
 * @deprecated 2026-07-10 Перплексити-логика: чтение контента топ-5 убрано
 * (ADDENDUM от 2026-07-10).
 *
 * Fetch HTML страницы и извлечь основной текст + AI-суммаризация.
 *
 * Pipeline: fetchWithRetry → cheerio-clean (убираем навигационный шум) →
 * текст из article||main||body → truncate до maxChars → опциональная
 * AI-выжимка через callRouterAI. Любая ошибка — graceful: возвращаем
 * { url, title:'', extractedText:'' }, чтобы вызывающий код (searchYandexEnriched)
 * мог упасть на snippet из SERP.
 *
 * Функция оставлена в коде, но ВЫЗОВ убран из article-generation.mjs — теперь
 * Yandex используется только в snippet-only режиме (searchYandex). Не вызывать.
 *
 * @param {string} url
 * @param {{ callRouterAI?: Function, maxChars?: number }} [opts]
 * @returns {Promise<{ url: string, title: string, extractedText: string }>}
 */
export async function fetchAndExtract(url, opts = {}) {
  const { callRouterAI, maxChars = FETCH_DEFAULT_MAX_CHARS } = opts;

  if (!url || typeof url !== 'string') {
    return { url: url || '', title: '', extractedText: '' };
  }

  let html = '';
  try {
    const result = await fetchWithRetry(url, { timeout: FETCH_PAGE_TIMEOUT_MS });
    if (!result.ok || !result.html) {
      return { url, title: '', extractedText: '' };
    }
    html = result.html;
  } catch {
    // Любой непредвиденный сбой — не роняем пайплайн.
    return { url, title: '', extractedText: '' };
  }

  let pageTitle = '';
  let pageText = '';
  try {
    const $ = load(html);
    // Убираем навигационный/шумовой контент, чтобы提取ать только «тело» статьи.
    $(
      'script,style,nav,footer,header,aside,iframe,noscript,svg,form,button,figcaption'
    ).remove();

    pageTitle =
      $('title').first().text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('h1').first().text().trim() ||
      '';
    pageTitle = pageTitle.slice(0, 300);

    // Приоритет: <article> → <main> → <body>. article/main — самый чистый контент.
    const container =
      $('article').first().length
        ? $('article').first()
        : $('main').first().length
          ? $('main').first()
          : $('body');

    pageText = container
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);
  } catch {
    // cheerio упал на битом HTML — отдаём пусто, без крэша.
    return { url, title: pageTitle, extractedText: '' };
  }

  if (!pageText) {
    return { url, title: pageTitle, extractedText: '' };
  }

  // Базовый результат — усечённый чистый текст. AI-суммаризация опциональна.
  let extractedText = pageText;
  if (typeof callRouterAI === 'function') {
    try {
      const summary = await summarizeWithAI(callRouterAI, pageText);
      if (summary) extractedText = summary;
    } catch {
      // AI упал — отдаём усечённый текст как есть (spec: «вернуть усечённый текст как есть»).
    }
  }

  return { url, title: pageTitle, extractedText };
}

/**
 * @deprecated 2026-07-10 Перплексити-логика: чтение контента топ-5 убрано
 * (ADDENDUM от 2026-07-10).
 *
 * Поиск Yandex + обогащение top-N результатов контентом (evidence-слой).
 *
 * 1. searchYandex → SERP.
 * 2. top.slice(0, topN) → fetchAndExtract для каждого (concurrency=3, чтобы не
 *    долбить внешние сайты параллельно).
 * 3. Нормализуем под контракт ResearchSource (provider/sourceUrl/title/snippet/
 *    extractedText/evidenceLevel). Отдельный упавший fetch НЕ выкидывает элемент
 *    — оставляем snippet из SERP как fallback (extractedText:'' , title из SERP).
 *
 * Функция оставлена в коде, но ВЫЗОВ убран из article-generation.mjs — теперь
 * Yandex используется только в snippet-only режиме (searchYandex). Не вызывать.
 *
 * @param {{ query: string, topN?: number, callRouterAI?: Function }} opts
 * @returns {Promise<Array<{ provider: string, sourceUrl: string, title: string, snippet: string, extractedText: string, evidenceLevel: string }>>}
 */
export async function searchYandexEnriched({ query, topN = 5, callRouterAI } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const { results } = await searchYandex({ query });
  const top = (results || []).slice(0, Math.max(1, topN));
  if (!top.length) return [];

  const enriched = new Array(top.length);
  const CONCURRENCY = Math.min(3, top.length);
  let cursor = 0;

  async function worker() {
    while (cursor < top.length) {
      const idx = cursor++;
      const r = top[idx];

      let extraction = { url: r.url, title: r.title || '', extractedText: '' };
      try {
        extraction = await fetchAndExtract(r.url, { callRouterAI });
      } catch {
        // graceful: extraction остаётся пустой — fallback на SERP-данные ниже.
      }

      enriched[idx] = {
        provider: 'yandex',
        sourceUrl: r.url,
        title: extraction.title || r.title || '',
        snippet: r.snippet || '',
        extractedText: extraction.extractedText || '',
        evidenceLevel: 'medium',
      };
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return enriched;
}

export async function searchYandex({
  query,
  page = 0,
  region = '213',
  maxAttempts = POLL_MAX_ATTEMPTS,
  intervalMs = POLL_INTERVAL_MS,
  apiKey: apiKeyOverride,
  fetchImpl,
}) {
  const startedAt = Date.now();

  const operationId = await startYandexSearch({ query, page, region, apiKey: apiKeyOverride, fetchImpl });

  let attempts = 0;
  let lastResult;
  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    attempts += 1;
    lastResult = await pollYandexOperation(operationId, { apiKey: apiKeyOverride, fetchImpl });
    if (lastResult.done) break;
  }

  const elapsedMs = Date.now() - startedAt;

  if (!lastResult || !lastResult.done) {
    return { results: [], totalOperations: attempts, elapsedMs, error: 'Таймаут ожидания операции Yandex Search.' };
  }

  if (lastResult.error && (!lastResult.results || lastResult.results.length === 0)) {
    return { results: [], totalOperations: attempts, elapsedMs, error: lastResult.error };
  }

  return {
    results: lastResult.results || [],
    totalOperations: attempts,
    elapsedMs,
  };
}
