// @vitest-environment jsdom
/**
 * M8 — экспорт статьи в панели результата (docs/ui-design.md §10).
 *
 * Контракт под тестом: три действия копирования (HTML / TXT / Markdown),
 * в буфер уходит payload статьи, после копирования кнопка показывает
 * «Скопировано».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ResultView } from '../../src/features/generation/ResultView';
import { I18nProvider } from '../../src/i18n';
import { apiGet } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE_ID = '33333333-3333-3333-3333-333333333333';

const CONTENT = {
  title: 'Статья',
  description: '',
  h1: 'Заголовок',
  contentHtml: '<h1>Заголовок</h1><p>Текст статьи.</p>',
  contentText: 'Заголовок\n\nТекст статьи.',
  contentMarkdown: '# Заголовок\n\nТекст статьи.',
  characterCount: 1200,
  coverFile: null,
  coverUnavailableReason: null,
  coverModel: null,
  coverCostRub: null,
  coverGeneratedAt: null,
  coverStatus: null,
  coverSkipReason: null,
  coverAvailable: false,
};

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

let writeText;

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(ResultView, { articleId: ARTICLE_ID }),
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
  apiGet.mockResolvedValue({ success: true, data: CONTENT });
  writeText = vi.fn(async () => {});
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis.window, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
});

describe('ResultView — экспорт статьи', () => {
  it('показывает три кнопки копирования', async () => {
    const container = render();
    await flush();
    expect(buttonByText(container, 'Скопировать HTML')).toBeTruthy();
    expect(buttonByText(container, 'Скопировать TXT')).toBeTruthy();
    expect(buttonByText(container, 'Скопировать Markdown')).toBeTruthy();
  });

  it('копирует готовый HTML статьи', async () => {
    const container = render();
    await flush();
    await act(async () => {
      buttonByText(container, 'Скопировать HTML').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeText).toHaveBeenCalledWith(CONTENT.contentHtml);
  });

  it('копирует markdown статьи', async () => {
    const container = render();
    await flush();
    await act(async () => {
      buttonByText(container, 'Скопировать Markdown').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeText).toHaveBeenCalledWith(CONTENT.contentMarkdown);
  });

  it('после копирования показывает «Скопировано»', async () => {
    const container = render();
    await flush();
    await act(async () => {
      buttonByText(container, 'Скопировать TXT').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(buttonByText(container, 'Скопировано')).toBeTruthy();
  });
});
