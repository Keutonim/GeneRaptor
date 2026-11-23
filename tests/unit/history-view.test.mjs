// @vitest-environment jsdom
/**
 * M6 — вкладка «История» (docs/ui-design.md §7).
 *
 * Контракт под тестом: список прошлых статей, открытие статьи в разделе
 * «Генерация», удаление с подтверждением, точки входа для экспорта.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { HistoryView } from '../../src/features/history/HistoryView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiDelete } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLES = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    topic: 'Как выбрать провайдера',
    status: 'completed',
    targetLength: 65000,
    language: 'ru',
    createdAt: '2026-11-10T10:00:00.000Z',
    coverStatus: null,
    coverSkipReason: null,
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    topic: 'Локальные модели для статей',
    status: 'failed',
    targetLength: 50000,
    language: 'ru',
    createdAt: '2026-11-11T10:00:00.000Z',
    coverStatus: null,
    coverSkipReason: null,
  },
];

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

function render(onOpen) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(HistoryView, { onOpen }),
      ),
    );
  });
  return container;
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
  apiGet.mockResolvedValue({ success: true, data: { items: ARTICLES, total: 2, limit: 50, offset: 0 } });
  apiDelete.mockResolvedValue(undefined);
});

describe('HistoryView — история', () => {
  it('показывает список статей со статусом и датой', async () => {
    const container = render(() => {});
    await flush();
    expect(container.querySelectorAll('.history__row')).toHaveLength(2);
    expect(container.textContent).toContain('Как выбрать провайдера');
    expect(container.textContent).toContain('готово');
    expect(container.textContent).toContain('ошибка');
  });

  it('открытие статьи вызывает onOpen с её id', async () => {
    const opened = [];
    const container = render((id) => opened.push(id));
    await flush();
    const menu = container.querySelector('.history__row button');
    act(() => {
      menu.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      buttonByText(container, 'Открыть').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('удаление спрашивает подтверждение и вызывает DELETE', async () => {
    const container = render(() => {});
    await flush();
    const menu = container.querySelector('.history__row button');
    act(() => {
      menu.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      buttonByText(container, 'Удалить').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(apiDelete).not.toHaveBeenCalled();
    act(() => {
      buttonByText(container, 'Удалить безвозвратно').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(apiDelete).toHaveBeenCalledWith('/api/articles/11111111-1111-1111-1111-111111111111');
  });

  it('в меню строки есть точки входа для экспорта', async () => {
    const container = render(() => {});
    await flush();
    const menu = container.querySelector('.history__row button');
    act(() => {
      menu.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(buttonByText(container, 'Скопировать HTML')).toBeTruthy();
    expect(buttonByText(container, 'Скопировать TXT')).toBeTruthy();
    expect(buttonByText(container, 'Скопировать Markdown')).toBeTruthy();
  });
});
