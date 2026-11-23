// @vitest-environment jsdom
/**
 * S5 T6 — панель настроек обложки смонтирована; модель обложки — один источник.
 *
 * Контракт под тестом:
 *  - в «Настройках» есть секция «Генерация обложек» рядом с «Моделями»
 *    (канон продукта, SettingsPanel: отдельная вкладка cover), панель делает GET;
 *  - строка уровня cover в таблице «Модели» — ПРОИЗВОДНАЯ от cover_settings.model
 *    (а не от provider.models.cover) и доступна только для чтения;
 *  - панель сохраняет модель существующим PUT /api/settings/cover;
 *  - configured:false — честное сообщение о значениях по умолчанию, без падения.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SettingsView } from '../../src/features/settings/SettingsView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPut } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

const COVER_PAYLOAD = {
  configured: true,
  enabled: true,
  model: 'settings/cover-model',
  compressionModel: 'deepseek/deepseek-v4-flash',
  compressionModelSource: 'override',
  promptTemplate: 'Шаблон обложки. {articleBrief}',
  aspectRatio: '16:9',
  resolution: '1K',
  quality: 'high',
  outputFormat: 'png',
  autoGenerate: false,
  monthlyCapRub: 300,
  available: true,
  unavailableReason: null,
  estimatedCoverCostRub: 5,
  spentThisMonthRub: 0,
};

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
    // The legacy second source: the provider tier pin must NOT win.
    models: { critical: 'qwen/qwen3.7-plus', cover: 'legacy/cover-model' },
  },
];

function mockApi(coverPayload = COVER_PAYLOAD) {
  apiGet.mockImplementation(async (url) => {
    const u = String(url);
    if (u === '/api/settings/cover') return { success: true, data: coverPayload };
    if (u === '/api/settings/providers') return { success: true, data: { providers: PROVIDERS } };
    if (u.startsWith('/api/providers/')) return { success: true, data: { models: ['settings/cover-model', 'qwen/qwen-image-2.1-pro'] } };
    if (u === '/api/settings/agent-roles') return { success: true, data: { roles: [] } };
    if (u === '/api/search/backends') return { success: true, data: { backends: [] } };
    return { success: true, data: {} };
  });
}

const mounted = [];

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(I18nProvider, { initialLocale: 'ru' }, React.createElement(SettingsView, null)),
    );
  });
  mounted.push({ root, container });
  return container;
}

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

function click(el) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function coverRow(container) {
  return Array.from(container.querySelectorAll('[data-section="models"] tbody tr')).find((tr) =>
    tr.textContent.includes('обложка'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
  apiPut.mockResolvedValue({ success: true, data: COVER_PAYLOAD });
});

describe('SettingsView — секция обложки (S5 T6)', () => {
  it('панель смонтирована рядом с «Моделями» и делает GET /api/settings/cover', async () => {
    const container = render();
    await flush();
    const sections = Array.from(container.querySelectorAll('section.settings__section')).map((s) =>
      s.getAttribute('data-section'),
    );
    expect(sections).toEqual(['providers', 'models', 'cover', 'roles']);
    expect(container.querySelector('[data-section="cover"] [aria-label="Настройки генерации обложек"]')).not.toBeNull();
    expect(apiGet).toHaveBeenCalledWith('/api/settings/cover');
  });

  it('строка cover в «Моделях» — производная от настроек обложки, только чтение', async () => {
    const container = render();
    await flush();
    const row = coverRow(container);
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('settings/cover-model');
    expect(row.textContent).not.toContain('legacy/cover-model');
    // Read-only: no replacement select/apply for the derived cover tier.
    expect(row.querySelector('select')).toBeNull();
    expect(row.textContent).toContain('Управляется в разделе');
    // Text tiers keep their replacement controls.
    const criticalRow = Array.from(container.querySelectorAll('[data-section="models"] tbody tr')).find((tr) =>
      tr.textContent.includes('critical'),
    );
    expect(criticalRow.querySelector('select')).not.toBeNull();
  });

  it('панель сохраняет модель существующим PUT /api/settings/cover', async () => {
    const container = render();
    await flush();
    const panel = container.querySelector('[data-section="cover"]');
    // 'settings/cover-model' is not a known option → the free-text id input is shown.
    const modelInput = panel.querySelector('input[placeholder="Например: qwen/qwen-image-3-pro"]');
    expect(modelInput).not.toBeNull();
    setInputValue(modelInput, 'new/cover-model');
    const saveButton = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сохранить');
    click(saveButton);
    await flush();
    expect(apiPut).toHaveBeenCalledWith('/api/settings/cover', expect.objectContaining({ model: 'new/cover-model' }));
  });

  it('configured:false — честное сообщение о значениях по умолчанию, без падения', async () => {
    mockApi({ ...COVER_PAYLOAD, configured: false });
    const container = render();
    await flush();
    const panel = container.querySelector('[data-section="cover"]');
    expect(panel.textContent).toContain('по умолчанию');
    expect(panel.querySelector('[aria-label="Настройки генерации обложек"]')).not.toBeNull();
  });

  it('после сохранения в панели производная строка «Моделей» обновляется (без расхождения)', async () => {
    const container = render();
    await flush();
    expect(coverRow(container).textContent).toContain('settings/cover-model');

    // The save persists a new model; the next GET reflects it.
    mockApi({ ...COVER_PAYLOAD, model: 'saved/cover-model' });
    const panel = container.querySelector('[data-section="cover"]');
    const modelInput = panel.querySelector('input[placeholder="Например: qwen/qwen-image-3-pro"]');
    setInputValue(modelInput, 'saved/cover-model');
    const saveButton = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сохранить');
    click(saveButton);
    await flush();

    expect(coverRow(container).textContent).toContain('saved/cover-model');
    expect(coverRow(container).textContent).not.toContain('settings/cover-model');
  });
});