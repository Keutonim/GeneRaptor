// @vitest-environment jsdom
/**
 * S5-ui — меню строки истории и подтверждение удаления как настоящий диалог.
 *
 * Контракт под тестом:
 *  - кнопка меню — иконка, а не текстовый глиф «⋯»;
 *  - меню строки закрывается по Escape (фокус остаётся на триггере);
 *  - подтверждение удаления — диалог: role=dialog, aria-modal, фокус-ловушка;
 *  - Escape закрывает подтверждение, фокус возвращается на кнопку меню.
 *
 * Поведение удаления (один DELETE, ошибка рядом с действием) проверяет
 * tests/unit/history-delete-ux.test.mjs — здесь только форма и клавиатура.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { HistoryView } from '../../src/features/history/HistoryView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiDelete } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE = {
  id: '11111111-1111-1111-1111-111111111111',
  topic: 'Как выбрать провайдера',
  status: 'completed',
  targetLength: 65000,
  language: 'ru',
  createdAt: '2026-11-10T10:00:00.000Z',
  coverStatus: null,
  coverSkipReason: null,
};

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

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(HistoryView, { onOpen: () => {} }),
      ),
    );
  });
  return container;
}

function click(el) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keyDown(el, key) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ success: true, data: { items: [ARTICLE], total: 1, limit: 50, offset: 0 } });
  apiDelete.mockResolvedValue(undefined);
});

describe('HistoryView — меню строки и диалог подтверждения (S5-ui)', () => {
  it('кнопка меню — иконка, а не текстовый глиф', async () => {
    const container = render();
    await flush();
    const trigger = container.querySelector('.history__menu');
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(trigger.textContent.trim()).toBe('');
  });

  it('Escape закрывает меню строки', async () => {
    const container = render();
    await flush();
    const trigger = container.querySelector('.history__menu');
    click(trigger);
    expect(container.querySelector('.history__actions')).not.toBeNull();
    keyDown(trigger, 'Escape');
    expect(container.querySelector('.history__actions')).toBeNull();
  });

  it('подтверждение удаления — диалог: role, aria-modal и имя по подписи', async () => {
    const container = render();
    await flush();
    click(container.querySelector('.history__menu'));
    click(buttonByText(container, 'Удалить'));

    const dialog = container.querySelector('[data-testid="history-delete-confirm"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    // React useId даёт идентификатор с двоеточиями — по нему ищем через
    // getElementById, а не через CSS-селектор.
    expect(document.getElementById(labelledBy).textContent.trim()).toBe('Удалить статью?');
    expect(document.getElementById(describedBy).textContent).toContain(ARTICLE.topic);
  });

  it('Escape закрывает подтверждение, фокус возвращается на кнопку меню', async () => {
    const container = render();
    await flush();
    const trigger = container.querySelector('.history__menu');
    click(trigger);
    click(buttonByText(container, 'Удалить'));

    const dialog = container.querySelector('[data-testid="history-delete-confirm"]');
    expect(dialog).not.toBeNull();
    // Фокус открыт на опасном действии.
    expect(document.activeElement?.textContent.trim()).toBe('Удалить безвозвратно');

    keyDown(dialog, 'Escape');
    expect(container.querySelector('[data-testid="history-delete-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('меню строки — role=menu, пункты — role=menuitem', async () => {
    const container = render();
    await flush();
    click(container.querySelector('.history__menu'));
    const menu = container.querySelector('.history__actions');
    expect(menu.getAttribute('role')).toBe('menu');
    const items = Array.from(menu.querySelectorAll('button'));
    expect(items.length).toBeGreaterThanOrEqual(7);
    for (const item of items) {
      expect(item.getAttribute('role')).toBe('menuitem');
    }
  });

  it('Escape из пункта меню закрывает меню и возвращает фокус на триггер', async () => {
    const container = render();
    await flush();
    const trigger = container.querySelector('.history__menu');
    click(trigger);
    const menu = container.querySelector('.history__actions');
    const firstItem = menu.querySelector('button');
    act(() => {
      firstItem.focus();
    });
    expect(document.activeElement).toBe(firstItem);
    keyDown(firstItem, 'Escape');
    expect(container.querySelector('.history__actions')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab зациклен внутри подтверждения: с последнего пункта на первый', async () => {
    const container = render();
    await flush();
    click(container.querySelector('.history__menu'));
    click(buttonByText(container, 'Удалить'));
    const dialog = container.querySelector('[data-testid="history-delete-confirm"]');
    const confirm = dialog.querySelector('[data-testid="history-delete-button"]');
    const cancel = Array.from(dialog.querySelectorAll('button')).find((b) => b !== confirm);
    expect(document.activeElement).toBe(confirm);
    keyDown(confirm, 'Tab');
    expect(document.activeElement).toBe(cancel);
    act(() => {
      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(confirm);
  });

  it('Escape закрывает подтверждение и во время удаления (фокус потерян заблокированной кнопкой)', async () => {
    // DELETE висит — кнопка подтверждения заблокирована, фокус ушёл с неё.
    apiDelete.mockReturnValue(new Promise(() => {}));
    const container = render();
    await flush();
    click(container.querySelector('.history__menu'));
    click(buttonByText(container, 'Удалить'));
    const confirm = container.querySelector('[data-testid="history-delete-button"]');
    click(confirm);
    await flush();
    expect(confirm.disabled).toBe(true);
    // Escape на уровне документа — диалог обязан закрыться, где бы ни был фокус.
    keyDown(document.body, 'Escape');
    expect(container.querySelector('[data-testid="history-delete-confirm"]')).toBeNull();
  });
});

describe('HistoryView — ошибка удаления не сжимается в колонку меню (S5-ui)', () => {
  it('.history__row > .error-text растянут на все колонки строки', async () => {
    // jsdom не считает grid-раскладку — контракт закреплён гвардом исходника
    // (тот же приём, что в cover-settings.test.mjs для CSS-фикса §7).
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/shell.css'), 'utf8');
    const match = css.match(/\.history__row > \.error-text \{([\s\S]*?)\}/);
    expect(match, 'правило .history__row > .error-text не найдено в shell.css').toBeTruthy();
    expect(match[1]).toContain('grid-column: 1 / -1');
  });
});
