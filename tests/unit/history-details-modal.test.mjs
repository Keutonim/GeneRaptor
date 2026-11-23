// @vitest-environment jsdom
/**
 * M8 — пункт «Сведения» в меню строки истории открывает модалку деталей
 * (docs/ui-design.md §7: детали статьи из истории, без новой вкладки).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { HistoryView } from '../../src/features/history/HistoryView';
import { I18nProvider } from '../../src/i18n';
import { apiGet } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE_ID = '11111111-1111-1111-1111-111111111111';

const ARTICLES = [
  {
    id: ARTICLE_ID,
    topic: 'Как выбрать провайдера',
    status: 'completed',
    targetLength: 65000,
    language: 'ru',
    createdAt: '2026-11-10T10:00:00.000Z',
    coverStatus: null,
    coverSkipReason: null,
  },
];

const DETAILS = {
  id: ARTICLE_ID,
  topic: 'Как выбрать провайдера',
  targetLength: 65000,
  characterCount: 61000,
  sourcesByProvider: { yandex: [] },
  sourcesTotal: 0,
  agentRuns: [],
};

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  ApiError: class ApiError extends Error {},
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
        React.createElement(HistoryView, { onOpen: () => {} }),
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

let fetchMock;

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ success: true, data: { items: ARTICLES, total: 1, limit: 50, offset: 0 } });
  fetchMock = vi.fn(async () => new Response(JSON.stringify(DETAILS), { status: 200 }));
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = undefined;
});

describe('M8 — «Сведения» в меню строки истории', () => {
  it('в меню строки есть пункт «Сведения»', async () => {
    const container = render();
    await flush();
    act(() => {
      container.querySelector('.history__row button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(buttonByText(container, 'Сведения')).toBeTruthy();
  });

  it('пункт «Сведения» открывает модалку с деталями статьи', async () => {
    const container = render();
    await flush();
    act(() => {
      container.querySelector('.history__row button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      buttonByText(container, 'Сведения').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(`/api/articles/${ARTICLE_ID}/details`);
    const panel = container.querySelector('.details__panel');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('Детали статьи');
    expect(panel.textContent).toContain('Как выбрать провайдера');
  });

  it('закрытие модалки убирает её из DOM', async () => {
    const container = render();
    await flush();
    act(() => {
      container.querySelector('.history__row button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      buttonByText(container, 'Сведения').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    act(() => {
      container.querySelector('.details__close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('.details__panel')).toBeNull();
  });
});
