// @vitest-environment jsdom
/**
 * M8 — модалка «Сведения» из меню строки истории (docs/ui-design.md §7).
 *
 * Контракт под тестом: модалка открывается по id статьи, показывает сводку
 * (тема, объём, качество, источники, роли), все подписи берутся из словаря
 * (RU/EN), а 404 не роняет интерфейс — показывается переводимое сообщение.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ArticleDetailsModal } from '../../src/components/ArticleDetailsModal';
import { I18nProvider } from '../../src/i18n';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE_ID = '11111111-1111-1111-1111-111111111111';

const PAYLOAD = {
  id: ARTICLE_ID,
  topic: 'Как выбрать провайдера',
  targetLength: 65000,
  characterCount: 61000,
  sourcesByProvider: {
    yandex: [
      {
        id: 'src-1',
        title: 'Материал о провайдерах',
        sourceUrl: 'https://example.com/a',
        evidenceLevel: 'B',
        snippet: 'Короткая выдержка',
      },
    ],
  },
  sourcesTotal: 1,
  agentRuns: [
    {
      agentName: 'Редактор',
      status: 'completed',
      inputTokens: 100,
      outputTokens: 200,
      costRub: 1.5,
      error: null,
    },
  ],
};

const originalFetch = globalThis.fetch;

function render(locale) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: locale },
        React.createElement(ArticleDetailsModal, {
          articleId: ARTICLE_ID,
          onClose: () => {},
        }),
      ),
    );
  });
  return container;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ArticleDetailsModal — сведения о статье', () => {
  it('показывает сводку статьи по-русски', async () => {
    const container = render('ru');
    await flush();
    expect(container.textContent).toContain('Детали статьи');
    expect(container.textContent).toContain('Тема');
    expect(container.textContent).toContain('Объём');
    expect(container.textContent).toContain('Как выбрать провайдера');
    expect(container.textContent).toContain('Источники');
    expect(container.textContent).toContain('Прогресс по ролям');
    expect(container.textContent).toContain('Редактор');
    expect(container.textContent).toContain(
      new Intl.NumberFormat('ru-RU').format(65000),
    );
  });

  it('в английской локали подписи английские', async () => {
    const container = render('en');
    await flush();
    expect(container.textContent).toContain('Article details');
    expect(container.textContent).toContain('Topic');
    expect(container.textContent).toContain('Volume');
    expect(container.textContent).toContain('Sources');
    expect(container.textContent).toContain('Progress by role');
  });

  it('ошибка 404 показывается переводимо и не роняет модалку', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const container = render('ru');
    await flush();
    expect(container.textContent).toContain('Статья не найдена');
    expect(container.querySelector('.details__panel')).toBeTruthy();
  });

  it('кнопка закрытия вызывает onClose', async () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(
          I18nProvider,
          { initialLocale: 'ru' },
          React.createElement(ArticleDetailsModal, { articleId: ARTICLE_ID, onClose }),
        ),
      );
    });
    await flush();
    const close = container.querySelector('button[aria-label="Закрыть"]');
    expect(close).toBeTruthy();
    act(() => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
