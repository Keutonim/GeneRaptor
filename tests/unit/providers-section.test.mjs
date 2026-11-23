// @vitest-environment jsdom
/**
 * M6 — раздел «Провайдеры и ключи» (docs/ui-design.md §8).
 *
 * Контракт под тестом: индикатор источника ключа (D10: локальное хранилище
 * или переменная окружения), проверка провайдера и сохранение ключа через
 * сервер (сервер — источник правды).
 *
 * S5-ui: бейдж поддержки изображений (D9) убран из карточки провайдера —
 * это свойство вида провайдера, а не действие; фактическая модель обложки
 * показывается в разделе «Модели» (уровень cover). Тест ниже закрепляет
 * именно это отсутствие.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ProvidersSection } from '../../src/features/settings/ProvidersSection';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPost, apiPut } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDERS = [
  {
    kind: 'routerai',
    label: 'RouterAI',
    baseUrl: 'https://routerai.ru/api/v1',
    enabled: true,
    keyConfigured: true,
    keySource: 'local',
    envKey: 'ROUTERAI_API_KEY',
    keyOptional: false,
    imagesCapability: 'yes',
    models: { critical: 'qwen/qwen3.7-plus' },
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: false,
    keyConfigured: false,
    keySource: 'env',
    envKey: 'OPENROUTER_API_KEY',
    keyOptional: false,
    imagesCapability: 'unknown',
    models: {},
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    enabled: false,
    keyConfigured: false,
    keySource: 'none',
    envKey: null,
    keyOptional: true,
    imagesCapability: 'no',
    models: {},
  },
];

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(ProvidersSection, null),
      ),
    );
  });
  return container;
}

/** Данные приходят с сервера асинхронно — дожидаемся их появления в DOM. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ success: true, data: { providers: PROVIDERS } });
  apiPost.mockResolvedValue({
    success: true,
    data: { provider: 'routerai', ok: true, level: 'ok', message: 'ok', latencyMs: 120, checkedAt: '2026-11-13T10:00:00.000Z' },
  });
  apiPut.mockResolvedValue(undefined);
});

describe('ProvidersSection — провайдеры и ключи', () => {
  it('показывает карточку на каждого провайдера', async () => {
    const container = render();
    await flush();
    expect(container.querySelectorAll('.provider-card')).toHaveLength(3);
  });

  it('показывает источник ключа: локальное хранилище, окружение, не задан', async () => {
    const container = render();
    await flush();
    const body = container.textContent;
    expect(body).toContain('локальное хранилище');
    expect(body).toContain('переменная окружения OPENROUTER_API_KEY');
    expect(body).toContain('не задан');
  });

  it('бейдж поддержки изображений (D9) в карточке провайдера отсутствует (S5-ui)', async () => {
    const container = render();
    await flush();
    const body = container.textContent;
    expect(body).not.toContain('изображения:');
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('проверка провайдера идёт на серверный маршрут', async () => {
    const container = render();
    await flush();
    const check = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Проверить');
    act(() => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(apiPost).toHaveBeenCalledWith('/api/settings/providers/routerai/test', {});
  });

  it('ключ сохраняется через PUT на сервер', async () => {
    const container = render();
    await flush();
    const input = container.querySelector('input[type="password"], input[type="text"]');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'secret-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сохранить ключ');
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(apiPut).toHaveBeenCalledWith('/api/settings/providers/routerai', { apiKey: 'secret-key' });
  });
});
