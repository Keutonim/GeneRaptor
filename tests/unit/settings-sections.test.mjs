// @vitest-environment jsdom
/**
 * M6 — страница настроек (docs/ui-design.md §8).
 *
 * Контракт под тестом: «Провайдеры и ключи → Модели → Генерация обложек → Роли».
 * S5 T6: панель обложки смонтирована отдельной секцией рядом с «Моделями»
 * (канон продукта, SettingsPanel); прежний запрет QA X1 отменён брифом S5 T6.
 * Раздела «Общие» по-прежнему нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SettingsView } from '../../src/features/settings/SettingsView';
import { I18nProvider } from '../../src/i18n';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(async () => ({ success: true, data: { providers: [], roles: [] } })),
  apiPost: vi.fn(async () => ({ success: true, data: {} })),
  apiPut: vi.fn(async () => undefined),
  apiDelete: vi.fn(async () => undefined),
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
        React.createElement(SettingsView, null),
      ),
    );
  });
  return container;
}

describe('SettingsView — структура настроек', () => {
  let container;

  beforeEach(() => {
    container = render();
  });

  it('показывает ровно четыре раздела (S5 T6: добавлена обложка)', () => {
    expect(container.querySelectorAll('section.settings__section')).toHaveLength(4);
  });

  it('разделы идут в порядке «Провайдеры и ключи → Модели → Генерация обложек → Роли»', () => {
    const titles = Array.from(container.querySelectorAll('section.settings__section h2')).map((el) =>
      el.textContent.trim(),
    );
    expect(titles).toEqual(['Провайдеры и ключи', 'Модели', 'Генерация обложек', 'Роли']);
  });

  it('секция обложки на месте, общего раздела нет', () => {
    const body = container.textContent;
    expect(body).toContain('Генерация обложек');
    expect(body).not.toContain('Общие');
    expect(container.querySelector('[data-section="cover"]')).not.toBeNull();
  });
});
