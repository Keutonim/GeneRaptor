// @vitest-environment jsdom
/**
 * M6 — панель обложки в результате (docs/ui-design.md §9).
 *
 * Контракт под тестом (M5, локальное хранилище обложек):
 *   - статья отдаёт `coverFile` (имя файла в <data-dir>/covers/), а не coverUrl;
 *   - байты обложки отдаёт GET /api/articles/:id/cover (image/png);
 *   - POST /api/articles/:id/cover отвечает { coverFile, model, costRub };
 *   - коды ошибок: cover_save_failed, cover_not_configured,
 *     cover_provider_images_unsupported, cover_not_found.
 *
 * Состояния «не запрашивалась» / «готова», действия «Сгенерировать обложку»
 * (POST без тела), «Перегенерировать по уточнению» (POST с refinement) и
 * «Сгенерировать заново» (POST с fresh).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { CoverPanel } from '../../src/features/generation/CoverPanel';
import { I18nProvider } from '../../src/i18n';
import { apiPost } from '../../src/hooks/useApi';
import { ApiError } from '../../src/hooks/useApi';
import { coverErrorMessage } from '../../src/data/cover';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
    }
  },
}));

function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(CoverPanel, props),
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
  apiPost.mockResolvedValue({
    success: true,
    data: { coverFile: 'cover.png', model: 'qwen/qwen-image-2.1-pro', costRub: 13 },
  });
});

describe('CoverPanel — обложка', () => {
  it('показывает состояние «обложка не запрашивалась» и кнопку генерации', () => {
    const container = render({ articleId: ARTICLE_ID, coverFile: null, coverAvailable: true });
    expect(container.textContent).toContain('Обложка не запрашивалась');
    expect(buttonByText(container, 'Сгенерировать обложку')).toBeTruthy();
  });

  it('в готовом состоянии показывает картинку и все действия', () => {
    const container = render({
      articleId: ARTICLE_ID,
      coverFile: 'cover.png',
      coverModel: 'qwen/qwen-image-2.1-pro',
      coverCostRub: 13,
      coverStatus: 'ready',
      coverAvailable: true,
    });
    expect(container.querySelector('img')).toBeTruthy();
    expect(buttonByText(container, 'Перегенерировать по уточнению')).toBeTruthy();
    expect(buttonByText(container, 'Сгенерировать заново')).toBeTruthy();
    expect(buttonByText(container, 'Скачать обложку')).toBeTruthy();
  });

  it('картинка и скачивание идут по маршруту байтов обложки', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new TextEncoder().encode('png-bytes'), { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:cover'),
      configurable: true,
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
    globalThis.fetch = fetchMock;
    try {
      const container = render({
        articleId: ARTICLE_ID,
        coverFile: 'cover.png',
        coverStatus: 'ready',
        coverAvailable: true,
      });
      expect(container.querySelector('img').getAttribute('src')).toBe(
        `/api/articles/${ARTICLE_ID}/cover`,
      );
      act(() => {
        buttonByText(container, 'Скачать обложку').dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
      await flush();
      expect(fetchMock.mock.calls[0][0]).toBe(`/api/articles/${ARTICLE_ID}/cover`);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      clickSpy.mockRestore();
    }
  });

  it('показывает причину недоступности обложки от сервера', () => {
    const container = render({
      articleId: ARTICLE_ID,
      coverFile: null,
      coverAvailable: false,
      coverUnavailableReason: 'cover_provider_images_unsupported',
    });
    expect(container.textContent).toContain('cover_provider_images_unsupported');
  });

  it('генерация с нуля идёт без тела', async () => {
    const container = render({
      articleId: ARTICLE_ID,
      coverFile: 'cover.png',
      coverStatus: 'ready',
      coverAvailable: true,
    });
    act(() => {
      buttonByText(container, 'Сгенерировать заново').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(apiPost).toHaveBeenCalledWith(`/api/articles/${ARTICLE_ID}/cover`, { fresh: true });
  });

  it('уточнение отправляется полем refinement', async () => {
    const container = render({
      articleId: ARTICLE_ID,
      coverFile: 'cover.png',
      coverStatus: 'ready',
      coverAvailable: true,
    });
    const input = container.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    act(() => {
      setter.call(input, 'Темнее фон, спокойнее цвета');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      buttonByText(container, 'Перегенерировать по уточнению').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(apiPost).toHaveBeenCalledWith(`/api/articles/${ARTICLE_ID}/cover`, {
      refinement: 'Темнее фон, спокойнее цвета',
    });
  });
});

describe('коды ошибок обложки M5 переводятся в русский текст', () => {
  it('cover_save_failed', () => {
    expect(coverErrorMessage(new ApiError('x', 'cover_save_failed'))).toContain('сохран');
  });

  it('cover_not_configured', () => {
    expect(coverErrorMessage(new ApiError('x', 'cover_not_configured'))).toContain('провайдер');
  });

  it('cover_provider_images_unsupported', () => {
    expect(coverErrorMessage(new ApiError('x', 'cover_provider_images_unsupported'))).toContain(
      'изображени',
    );
  });

  it('cover_not_found', () => {
    expect(coverErrorMessage(new ApiError('x', 'cover_not_found'))).toContain('Обложка');
  });
});
