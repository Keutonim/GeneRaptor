// @vitest-environment jsdom
/**
 * M8 — скачивание обложки из интерфейса (docs/ui-design.md §10).
 *
 * Контракт под тестом: в истории и в панели обложки кнопка «Скачать обложку»
 * забирает бинарник файлом; ответ 404/503 не роняет интерфейс, а показывается
 * переводимой строкой из словаря.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { HistoryView } from '../../src/features/history/HistoryView';
import { CoverPanel } from '../../src/features/generation/CoverPanel';
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
    coverStatus: 'ready',
    coverSkipReason: null,
  },
];

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        element,
      ),
    );
  });
  return container;
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === text,
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({
    success: true,
    data: { items: ARTICLES, total: 1, limit: 50, offset: 0 },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('скачивание обложки — интерфейс', () => {
  it('в меню строки истории есть кнопка скачивания обложки', async () => {
    const container = render(React.createElement(HistoryView, { onOpen: () => {} }));
    await flush();
    act(() => {
      container
        .querySelector('.history__row button')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(buttonByText(container, 'Скачать обложку')).toBeTruthy();
  });

  it('ответ 404 обложки показывает переводимое сообщение и не роняет строку', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, error: 'нет', code: 'cover_not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const container = render(React.createElement(HistoryView, { onOpen: () => {} }));
    await flush();
    act(() => {
      container
        .querySelector('.history__row button')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      buttonByText(container, 'Скачать обложку').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(container.textContent).toContain('Обложка не найдена');
    expect(container.textContent).not.toContain('undefined');
  });

  it('ответ 503 обложки в панели показывает переводимое сообщение', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const container = render(
      React.createElement(CoverPanel, {
        articleId: ARTICLE_ID,
        coverFile: 'cover.png',
        coverStatus: 'ready',
        coverAvailable: true,
      }),
    );
    expect(buttonByText(container, 'Скачать обложку')).toBeTruthy();
    act(() => {
      buttonByText(container, 'Скачать обложку').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(container.textContent).toContain('Не удалось скачать обложку');
  });
});
