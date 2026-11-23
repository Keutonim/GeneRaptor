// @vitest-environment jsdom
/**
 * S5 DEF-1 — разбор конвертов ошибок в useApi (РЕАЛЬНЫЙ парсер, не мок).
 *
 * Сервер отдаёт ДВА конверта ошибки:
 *  - плоский:   { success:false, error:'строка', code?, suggestion? }
 *               (articles.mjs U2, auth.mjs, articles 404);
 *  - вложенный: { success:false, error:{ code, message } }
 *               (providers.mjs fail() — типизированные ошибки валидации,
 *               provider-url.mjs / providers.mjs).
 *
 * До фикса парсер понимал только плоский: вложенный error-объект не
 * распознавался, и UI показывал res.statusText («Bad Request») вместо
 * канонического текста сервера. Существующий providers-endpoint.test.mjs
 * мокает useApi целиком, поэтому регрессия жила именно в парсере.
 *
 * Контракт под тестом:
 *  1. плоский конверт — message/code/suggestion доживают до ApiError;
 *  2. вложенный конверт — канонический message + code доживают до ApiError;
 *  3. неизвестный код без message — нейтральное сообщение, НЕ «Bad Request»;
 *  4. пустое/не-JSON тело — нейтральное сообщение, НЕ «Bad Request»;
 *  5. вложенный конверт только с message (500-путь fail(res, 'строка')) —
 *     текст сервера доживает до потребителя;
 *  6. ошибка серверной валидации endpoint появляется У ПОЛЯ (data-testid
 *     provider-endpoint-error-custom), а не только в консоли.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { apiPost, apiPut, ApiError } from '../../src/hooks/useApi';
import { ProvidersSection } from '../../src/features/settings/ProvidersSection';
import { I18nProvider } from '../../src/i18n';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ── helpers ─────────────────────────────────────────────────────────── */

const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 400, statusText = 'Bad Request') {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Стаб fetch, отдающий один фиксированный ответ на любой запрос. */
function stubFetchOnce(response) {
  globalThis.fetch = vi.fn(async () => response);
  return globalThis.fetch;
}

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/* ── 1–5: парсер конвертов (реальный useApi) ─────────────────────────── */

describe('useApi — единый разбор плоского и вложенного конвертов ошибки (DEF-1)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('плоский конверт: message, code и suggestion доживают до ApiError', async () => {
    stubFetchOnce(jsonResponse({
      success: false,
      error: 'Тема похожа на склейку поисковых фраз — оставьте одну фразу',
      code: 'topic_looks_like_concatenation',
      suggestion: 'одна фраза',
    }));

    const error = await captureError(apiPost('/api/articles', { topic: 'x' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Тема похожа на склейку поисковых фраз — оставьте одну фразу');
    expect(error.code).toBe('topic_looks_like_concatenation');
    expect(error.suggestion).toBe('одна фраза');
    expect(error.status).toBe(400);
  });

  it('вложенный конверт: канонический message и code сервера доживают до ApiError', async () => {
    stubFetchOnce(jsonResponse({
      success: false,
      error: { code: 'provider_url_private', message: 'Адрес провайдера указывает на внутреннюю сеть' },
    }));

    const error = await captureError(apiPut('/api/settings/providers/custom', { baseUrl: 'http://192.168.0.1/v1' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Адрес провайдера указывает на внутреннюю сеть');
    expect(error.code).toBe('provider_url_private');
    expect(error.status).toBe(400);
  });

  it('неизвестный код без message: нейтральное сообщение, не «Bad Request»', async () => {
    stubFetchOnce(jsonResponse({ success: false, error: { code: 'mystery_failure' } }));

    const error = await captureError(apiPut('/api/settings/providers/custom', { baseUrl: 'https://x.example/v1' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('mystery_failure');
    expect(error.message).not.toBe('Bad Request');
    expect(error.message).toBe('Ошибка 400');
  });

  it('пустое тело ответа: нейтральное сообщение, не «Bad Request»', async () => {
    stubFetchOnce(new Response('', { status: 400, statusText: 'Bad Request' }));

    const error = await captureError(apiPut('/api/settings/providers/custom', { baseUrl: 'https://x.example/v1' }));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toBe('Bad Request');
    expect(error.message).toBe('Ошибка 400');
  });

  it('вложенный конверт только с message (500-путь): текст сервера доживает до потребителя', async () => {
    stubFetchOnce(jsonResponse(
      { success: false, error: { message: 'Не удалось сохранить провайдера' } },
      500,
      'Internal Server Error',
    ));

    const error = await captureError(apiPut('/api/settings/providers/custom', { baseUrl: 'https://x.example/v1' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Не удалось сохранить провайдера');
    expect(error.status).toBe(500);
  });
});

/* ── 6: ошибка видна У ПОЛЯ (интеграция реального парсера и UI) ───────── */

function card(kind, overrides = {}) {
  return {
    kind,
    label: kind,
    baseUrl: '',
    enabled: false,
    keyConfigured: false,
    keySource: 'none',
    envKey: `${kind.toUpperCase()}_API_KEY`,
    keyOptional: true,
    imagesCapability: 'unknown',
    models: {},
    endpointSource: 'none',
    ...overrides,
  };
}

const PROVIDERS = [
  card('routerai', { baseUrl: 'https://routerai.ru/api/v1', endpointSource: 'canonical', keyOptional: false }),
  card('openrouter', { baseUrl: 'https://openrouter.ai/api/v1', endpointSource: 'canonical', keyOptional: false }),
  card('ollama', { baseUrl: 'http://localhost:11434/v1', endpointSource: 'canonical' }),
  card('custom'),
];

const mounted = [];

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(I18nProvider, { initialLocale: 'ru' }, React.createElement(ProvidersSection, null)),
    );
  });
  mounted.push({ root, container });
  return container;
}

// ProvidersSection keeps a 1s interval alive — unmount every root so a
// previous test's timers cannot fire inside the next test's act() window.
afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('DEF-1 — серверная ошибка endpoint показывается у поля, не в консоли', () => {
  beforeEach(() => {
    // Реальный useApi: стабируется ТОЛЬКО fetch, парсер конверта — боевой.
    globalThis.fetch = vi.fn(async (url, init) => {
      const target = String(url);
      const method = (init && init.method) || 'GET';
      if (method === 'PUT' && target === '/api/settings/providers/custom') {
        return jsonResponse({
          success: false,
          error: { code: 'provider_url_private', message: 'Адрес провайдера указывает на внутреннюю сеть' },
        });
      }
      if (target.includes('/api/settings/providers')) {
        return jsonResponse({ success: true, data: { providers: PROVIDERS } }, 200, 'OK');
      }
      if (target.includes('/api/search/backends')) {
        return jsonResponse({ success: true, data: { backends: [], selected: null } }, 200, 'OK');
      }
      return jsonResponse({ success: true, data: {} }, 200, 'OK');
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('вложенный конверт provider_url_private → канонический текст у поля custom', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render();
    await flush();

    const input = container.querySelector('#provider-endpoint-custom');
    expect(input).not.toBeNull();
    setInputValue(input, 'http://192.168.0.1/v1');
    const button = input.closest('.field').querySelector('button.button--primary');
    click(button);
    await flush();

    const errorNode = container.querySelector('[data-testid="provider-endpoint-error-custom"]');
    expect(errorNode).not.toBeNull();
    // Канонический перевод кода (ENDPOINT_ERROR_KEYS), а не «Bad Request».
    expect(errorNode.textContent).toBe('Адрес внутренней сети запрещён политикой');
    expect(container.textContent).not.toContain('Bad Request');
    // Ошибка привязана к полю доступности: aria-invalid + aria-describedby.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('provider-endpoint-error-custom');
    // UI не свалился в консоль вместо поля.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});