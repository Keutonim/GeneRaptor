// @vitest-environment jsdom
/**
 * S5 T5 — уточнения по теме на главной форме (канон продукта, ArticleForm).
 *
 * Контракт под тестом:
 *  - поле видно на ПЕРВОМ шаге: подпись «Уточнения к теме (необязательно)»,
 *    канонический placeholder, maxLength=1000, счётчик {n}/1000;
 *  - счётчик обновляется при вводе;
 *  - значение уходит в POST /api/articles полем userNotes (trim), отдельного
 *    шага «Уточнения» больше нет — один путь: тема → уточнения → генерация;
 *  - пустые уточнения не отправляются (userNotes отсутствует).
 *
 * Серверная валидация userNotes (trim, ≤1000, 400 USER_NOTES_TOO_LONG)
 * покрыта tests/integration/articles-validation.test.mjs и не меняется.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { GenerationView } from '../../src/features/generation/GenerationView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPost } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLE_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('../../src/hooks/useWebSocketProgress', () => ({
  useWebSocketProgress: () => ({ progress: null, error: null }),
}));

const mounted = [];

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(I18nProvider, { initialLocale: 'ru' }, React.createElement(GenerationView, null)),
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

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

/** The primary button — by its new label once it exists, by the old one before. */
function primaryButton(container) {
  return buttonByText(container, 'Начать генерацию') ?? buttonByText(container, 'Далее');
}

function click(el) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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
  apiGet.mockImplementation(async (url) => {
    if (url === '/api/settings/cover') {
      return { success: true, data: { available: true, unavailableReason: null, estimatedCoverCostRub: 13 } };
    }
    return { success: true, data: {} };
  });
  apiPost.mockImplementation(async (url) => {
    if (url === '/api/articles') return { success: true, data: { id: ARTICLE_ID } };
    return { success: true, data: {} };
  });
});

describe('Composer — уточнения к теме на главной (S5 T5)', () => {
  it('поле видно на первом шаге: каноническая подпись, placeholder, maxLength и счётчик', async () => {
    const container = render();
    await flush();
    const notes = container.querySelector('#composer-notes');
    expect(notes).not.toBeNull();
    expect(notes.getAttribute('maxlength')).toBe('1000');
    expect(notes.getAttribute('placeholder')).toBe(
      'Например: ультраформер нужно выставить в выигрышном свете и продавать именно его',
    );
    const label = container.querySelector('label[for="composer-notes"]');
    expect(label.textContent).toBe('Уточнения к теме (необязательно)');
    expect(container.textContent).toContain('0/1000');
  });

  it('счётчик обновляется при вводе', async () => {
    const container = render();
    await flush();
    setValue(container.querySelector('#composer-notes'), 'Ультраформер');
    expect(container.textContent).toContain('12/1000');
  });

  it('значение уходит в userNotes (trim), отдельного шага уточнений нет', async () => {
    const container = render();
    await flush();
    setValue(container.querySelector('#composer-topic'), 'Как выбрать провайдера для статей');
    setValue(container.querySelector('#composer-notes'), '  Продавать именно ультраформер  ');
    click(primaryButton(container));
    await flush();

    const createCall = apiPost.mock.calls.find((call) => call[0] === '/api/articles');
    expect(createCall).toBeTruthy();
    expect(createCall[1]).toMatchObject({
      topic: 'Как выбрать провайдера для статей',
      userNotes: 'Продавать именно ультраформер',
    });
    // One path only: the run sheet is next, no separate clarify step.
    expect(container.querySelector('#clarify-notes')).toBeNull();
    expect(apiPost).toHaveBeenCalledWith(`/api/articles/${ARTICLE_ID}/start`, { coverRequested: false });
    expect(container.querySelectorAll('.run-sheet__row').length).toBeGreaterThan(0);
  });

  it('пустые уточнения не отправляются', async () => {
    const container = render();
    await flush();
    setValue(container.querySelector('#composer-topic'), 'Как выбрать провайдера для статей');
    setValue(container.querySelector('#composer-notes'), '   ');
    click(primaryButton(container));
    await flush();
    const createCall = apiPost.mock.calls.find((call) => call[0] === '/api/articles');
    expect(createCall).toBeTruthy();
    expect(createCall[1].userNotes).toBeUndefined();
  });

  it('кнопки «Далее» больше нет — главная кнопка сразу запускает генерацию', async () => {
    const container = render();
    await flush();
    expect(buttonByText(container, 'Далее')).toBeUndefined();
    expect(buttonByText(container, 'Начать генерацию')).toBeTruthy();
  });
});