// @vitest-environment jsdom
/**
 * M6 — путь генерации (docs/ui-design.md §5).
 *
 * Контракт под тестом: тема + уточнения на главной → запуск (лист хода) → статья;
 * «Язык материала» (D6) уходит в POST /api/articles параметром language.
 * S5 T5: отдельный шаг «Уточнения» удалён — путь один.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { GenerationView } from '../../src/features/generation/GenerationView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPost } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE_ID = '11111111-1111-1111-1111-111111111111';

const { progressState } = vi.hoisted(() => ({ progressState: { current: null } }));

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('../../src/hooks/useWebSocketProgress', () => ({
  useWebSocketProgress: () => ({ progress: progressState.current, error: null }),
}));

function contentResponse() {
  return {
    success: true,
    data: {
      title: 'Как выбрать провайдера',
      description: 'Короткое описание',
      h1: 'Как выбрать провайдера',
      contentHtml: '<p>Текст статьи для проверки</p>',
      contentText: 'Текст статьи для проверки',
      contentMarkdown: '# Как выбрать провайдера',
      characterCount: 65000,
      coverUrl: null,
      coverModel: null,
      coverCostRub: null,
      coverGeneratedAt: null,
      coverStatus: null,
      coverSkipReason: null,
      coverAvailable: true,
    },
  };
}

function makeElement() {
  // Элемент создаётся заново на каждом рендере: React пропускает обновление
  // поддерева, если ссылка на элемент совпадает с предыдущей.
  return React.createElement(
    I18nProvider,
    { initialLocale: 'ru' },
    React.createElement(GenerationView, null),
  );
}

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(makeElement());
  });
  return {
    container,
    rerender: () => {
      act(() => {
        root.render(makeElement());
      });
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === text,
  );
}

function setValue(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  progressState.current = null;
  apiGet.mockImplementation(async (url) => {
    if (url === '/api/settings/cover') {
      return { success: true, data: { available: true, unavailableReason: null, estimatedCoverCostRub: 13 } };
    }
    if (url.endsWith('/content')) return contentResponse();
    return { success: true, data: {} };
  });
  apiPost.mockImplementation(async (url) => {
    if (url === '/api/articles') return { success: true, data: { id: ARTICLE_ID } };
    return { success: true, data: {} };
  });
});

describe('GenerationView — путь генерации', () => {
  it('язык материала по умолчанию совпадает с языком интерфейса и уходит в запрос', async () => {
    const { container } = render();
    await flush();

    const topic = container.querySelector('#composer-topic');
    setValue(topic, 'Как выбрать провайдера для статей');

    // S5 T5: уточнения переехали на главную форму, отдельного шага нет —
    // одна кнопка «Начать генерацию» сразу запускает прогон.
    act(() => {
      buttonByText(container, 'Начать генерацию').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    const createCall = apiPost.mock.calls.find((call) => call[0] === '/api/articles');
    expect(createCall).toBeTruthy();
    expect(createCall[1]).toMatchObject({ language: 'ru' });
  });

  it('английский язык материала отправляется параметром language', async () => {
    const { container } = render();
    await flush();

    const topic = container.querySelector('#composer-topic');
    setValue(topic, 'How to choose a provider for articles');

    const en = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (option) => option.textContent.trim() === 'EN',
    );
    act(() => {
      en.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // S5 T5: уточнения переехали на главную форму, отдельного шага нет —
    // одна кнопка «Начать генерацию» сразу запускает прогон.
    act(() => {
      buttonByText(container, 'Начать генерацию').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    const createCall = apiPost.mock.calls.find((call) => call[0] === '/api/articles');
    expect(createCall[1]).toMatchObject({ language: 'en' });
  });

  it('после запуска показывается лист хода из 11 этапов, затем — статья', async () => {
    progressState.current = {
      type: 'progress',
      articleId: ARTICLE_ID,
      currentStage: 3,
      totalStages: 11,
      stageName: 'Исследование',
      agentName: 'Исследователь',
      description: 'Собираем источники',
      percent: 27,
      status: 'running',
    };

    const { container, rerender } = render();
    await flush();

    setValue(container.querySelector('#composer-topic'), 'Как выбрать провайдера для статей');
    // S5 T5: уточнения переехали на главную форму, отдельного шага нет —
    // одна кнопка «Начать генерацию» сразу запускает прогон.
    act(() => {
      buttonByText(container, 'Начать генерацию').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    expect(apiPost).toHaveBeenCalledWith(`/api/articles/${ARTICLE_ID}/start`, { coverRequested: false });
    expect(container.querySelectorAll('.run-sheet__row')).toHaveLength(11);
    expect(container.querySelectorAll('.run-sheet__row--current')).toHaveLength(1);

    progressState.current = {
      type: 'progress',
      articleId: ARTICLE_ID,
      currentStage: 11,
      totalStages: 11,
      stageName: 'Готово',
      agentName: '',
      description: '',
      percent: 100,
      status: 'completed',
    };
    rerender();
    await flush();

    expect(container.querySelector('.galley__body').textContent).toContain('Текст статьи для проверки');
    expect(container.querySelector('.cover-panel')).toBeTruthy();
  });

  it('прогресс роли не переключает лист хода на готовую статью (H-06)', async () => {
    progressState.current = {
      type: 'progress',
      articleId: ARTICLE_ID,
      currentStage: 3,
      totalStages: 11,
      stageName: 'Исследование',
      agentName: 'Исследователь',
      description: 'Собираем источники',
      percent: 27,
      status: 'running',
    };

    const { container } = render();
    await flush();

    setValue(container.querySelector('#composer-topic'), 'Как выбрать провайдера для статей');
    // S5 T5: уточнения переехали на главную форму, отдельного шага нет —
    // одна кнопка «Начать генерацию» сразу запускает прогон.
    act(() => {
      buttonByText(container, 'Начать генерацию').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    // Лист хода на месте, готовой статьи ещё нет.
    expect(container.querySelectorAll('.run-sheet__row')).toHaveLength(11);
    expect(container.querySelector('.galley__body')).toBeNull();
  });

  it('прогон, сохранённый для проверки (needs-review), показывается как готовая статья (H-06)', async () => {
    progressState.current = {
      type: 'progress',
      articleId: ARTICLE_ID,
      currentStage: 8,
      totalStages: 11,
      stageName: 'Фактчек',
      agentName: 'factchecker',
      description: 'Проверяем факты',
      percent: 73,
      status: 'running',
    };

    const { container, rerender } = render();
    await flush();

    setValue(container.querySelector('#composer-topic'), 'Как выбрать провайдера для статей');
    // S5 T5: уточнения переехали на главную форму, отдельного шага нет —
    // одна кнопка «Начать генерацию» сразу запускает прогон.
    act(() => {
      buttonByText(container, 'Начать генерацию').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    expect(container.querySelector('.galley__body')).toBeNull();

    // Финальный кадр: контент сохранён, требуется ручная проверка.
    progressState.current = {
      type: 'progress',
      articleId: ARTICLE_ID,
      currentStage: 11,
      totalStages: 11,
      stageName: 'Требуется проверка',
      agentName: 'factchecker',
      description: 'Контент сохранён, требуется ручная проверка',
      percent: 100,
      status: 'needs-review',
    };
    rerender();
    await flush();

    expect(container.querySelector('.galley__body').textContent).toContain('Текст статьи для проверки');
  });

  it('статья из «Истории» со статусом needs_review открывается сразу как статья (H-06)', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url === `/api/articles/${ARTICLE_ID}`) {
        return {
          success: true,
          data: { id: ARTICLE_ID, status: 'needs_review', language: 'ru', title: 'Статья' },
        };
      }
      if (url.endsWith('/content')) return contentResponse();
      if (url === '/api/settings/cover') {
        return { success: true, data: { available: true, unavailableReason: null, estimatedCoverCostRub: 13 } };
      }
      return { success: true, data: {} };
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(
          I18nProvider,
          { initialLocale: 'ru' },
          React.createElement(GenerationView, { articleId: ARTICLE_ID }),
        ),
      );
    });
    await flush();

    // Сырой статус БД 'needs_review' не должен оставлять пользователя на
    // листе хода — статья сохранена и ждёт только ручной проверки.
    expect(container.querySelector('.galley__body').textContent).toContain('Текст статьи для проверки');
    expect(container.querySelectorAll('.run-sheet__row')).toHaveLength(0);
  });

  it('если провайдер не настроен — компоновер предлагает задать ключ в настройках', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url === '/api/settings/providers') {
        return {
          success: true,
          data: {
            providers: [
              {
                kind: 'routerai',
                label: 'RouterAI',
                enabled: true,
                keyConfigured: false,
                keyOptional: false,
                imagesCapability: 'yes',
              },
            ],
          },
        };
      }
      if (url === '/api/settings/cover') {
        return { success: true, data: { available: true, unavailableReason: null, estimatedCoverCostRub: 13 } };
      }
      return { success: true, data: {} };
    });

    const { container } = render();
    await flush();

    expect(container.textContent).toContain('Провайдер не настроен');
  });
});
