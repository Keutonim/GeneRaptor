// @vitest-environment jsdom
/**
 * S5 T4 — поле base URL (endpoint) у провайдеров custom и ollama.
 *
 * Сервер уже умеет хранить и валидировать адрес (PUT /api/settings/providers/:kind,
 * provider-url.mjs). Контракт под тестом — UI-слой:
 *  - поле видно ТОЛЬКО у custom и ollama; у routerai/openrouter — read-only
 *    подсказка про окружение;
 *  - значение уходит в СУЩЕСТВУЮЩИЙ контракт saveProvider(kind, { baseUrl })
 *    и читается обратно после перезагрузки списка;
 *  - пустой адрес у custom — понятная ошибка рядом с полем (без запроса);
 *  - серверные коды валидации показываются рядом с полем переводимым текстом;
 *  - мягкая клиентская проверка схемы и логина/пароля — до запроса.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ProvidersSection } from '../../src/features/settings/ProvidersSection';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPut, ApiError } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/hooks/useApi', () => {
  class MockApiError extends Error {
    constructor(message, code, suggestion, status) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.suggestion = suggestion ?? null;
      this.status = status;
    }
  }
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
    ApiError: MockApiError,
  };
});

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
  card('custom', { baseUrl: '', endpointSource: 'none' }),
];

function providersPayload(list = PROVIDERS) {
  return { success: true, data: { providers: list } };
}

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

function endpointInput(container, kind) {
  return container.querySelector(`#provider-endpoint-${kind}`);
}

function saveButton(container, kind) {
  const input = endpointInput(container, kind);
  return input.closest('.field').querySelector('button.button--primary');
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url) => {
    if (String(url).includes('/api/settings/providers')) return providersPayload();
    return { success: true, data: { backends: [] } };
  });
  apiPut.mockResolvedValue({ success: true, data: {} });
});

describe('ProvidersSection — поле endpoint (S5 T4)', () => {
  it('поле видно только у custom и ollama; у фиксированных — подсказка про окружение', async () => {
    const container = render();
    await flush();
    expect(endpointInput(container, 'custom')).not.toBeNull();
    expect(endpointInput(container, 'ollama')).not.toBeNull();
    expect(endpointInput(container, 'routerai')).toBeNull();
    expect(endpointInput(container, 'openrouter')).toBeNull();
    expect(container.textContent).toContain('Адрес фиксированный');
  });

  it('ollama предзаполнен своим адресом, custom — пуст', async () => {
    const container = render();
    await flush();
    expect(endpointInput(container, 'ollama').value).toBe('http://localhost:11434/v1');
    expect(endpointInput(container, 'custom').value).toBe('');
  });

  it('значение сохраняется существующим контрактом и читается обратно', async () => {
    const container = render();
    await flush();
    setInputValue(endpointInput(container, 'custom'), 'https://api.example.com/v1');
    // After the save the server returns the stored address.
    apiGet.mockImplementation(async (url) => {
      if (String(url).includes('/api/settings/providers')) {
        return providersPayload(PROVIDERS.map((p) => (p.kind === 'custom' ? { ...p, baseUrl: 'https://api.example.com/v1', endpointSource: 'stored' } : p)));
      }
      return { success: true, data: { backends: [] } };
    });
    click(saveButton(container, 'custom'));
    await flush();
    expect(apiPut).toHaveBeenCalledWith('/api/settings/providers/custom', { baseUrl: 'https://api.example.com/v1' });
    expect(endpointInput(container, 'custom').value).toBe('https://api.example.com/v1');
  });

  it('пустой адрес у custom даёт понятную ошибку рядом с полем, без запроса', async () => {
    const container = render();
    await flush();
    click(saveButton(container, 'custom'));
    await flush();
    expect(apiPut).not.toHaveBeenCalled();
    const errorNode = container.querySelector('[data-testid="provider-endpoint-error-custom"]');
    expect(errorNode).not.toBeNull();
    expect(errorNode.textContent).toContain('адрес обязателен');
  });

  it('серверный код валидации показывается рядом с полем переводимым текстом', async () => {
    apiPut.mockRejectedValueOnce(new ApiError('Адрес провайдера должен использовать http или https', 'provider_url_scheme', null, 400));
    const container = render();
    await flush();
    setInputValue(endpointInput(container, 'custom'), 'https://api.example.com/v1');
    click(saveButton(container, 'custom'));
    await flush();
    const errorNode = container.querySelector('[data-testid="provider-endpoint-error-custom"]');
    expect(errorNode).not.toBeNull();
    expect(errorNode.textContent).toContain('Только http или https');
  });

  it('мягкая проверка: ftp-схема и логин/пароль отсекаются до запроса', async () => {
    const container = render();
    await flush();
    setInputValue(endpointInput(container, 'custom'), 'ftp://x.example');
    click(saveButton(container, 'custom'));
    await flush();
    expect(apiPut).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="provider-endpoint-error-custom"]').textContent).toContain('Только http или https');

    setInputValue(endpointInput(container, 'custom'), 'http://user:pass@host.example/v1');
    click(saveButton(container, 'custom'));
    await flush();
    expect(apiPut).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="provider-endpoint-error-custom"]').textContent).toContain('Логин/пароль');
  });
});