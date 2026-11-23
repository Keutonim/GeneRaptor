// @vitest-environment jsdom
/**
 * S5 T2 — незавершённость UI-слоя удаления (results/s5-analysis.md §5.1).
 *
 * Контракт под тестом:
 *  - открытие подтверждения закрывает меню строки (не две наложенные панели);
 *  - ошибка удаления рендерится РЯДОМ с действием (в строке), а не в начале
 *    секции; блок подтверждения не «залипает» после ошибки;
 *  - стабильные якоря data-testid для дизайнера и e2e;
 *  - двойной клик по «Удалить безвозвратно» даёт ровно один DELETE;
 *  - 404 («уже удалена») — нейтральное сообщение, строка убрана, не ошибка.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { HistoryView } from '../../src/features/history/HistoryView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiDelete, ApiError } from '../../src/hooks/useApi';

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

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Open the row menu and click «Удалить» — the confirmation is now open. */
function openConfirm(container) {
  click(container.querySelector('[data-testid="history-delete-menu"]') ?? container.querySelector('.history__menu'));
  click(buttonByText(container, 'Удалить'));
}

/** The confirm button — by testid once it exists, by text before that. */
function confirmButton(container) {
  return (
    container.querySelector('[data-testid="history-delete-button"]') ??
    buttonByText(container, 'Удалить безвозвратно')
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ success: true, data: { items: [ARTICLE], total: 1, limit: 50, offset: 0 } });
  apiDelete.mockResolvedValue(undefined);
});

describe('HistoryView — UX удаления (S5 T2)', () => {
  it('открытие подтверждения закрывает меню строки', async () => {
    const container = render();
    await flush();
    click(container.querySelector('.history__menu'));
    expect(container.querySelector('.history__actions')).not.toBeNull();
    click(buttonByText(container, 'Удалить'));
    expect(container.querySelector('.history__actions')).toBeNull();
    expect(container.querySelector('.history__confirm')).not.toBeNull();
  });

  it('несёт стабильные data-testid якоря для меню, подтверждения и кнопки', async () => {
    const container = render();
    await flush();
    const menuButton = container.querySelector('[data-testid="history-delete-menu"]');
    expect(menuButton).not.toBeNull();
    click(menuButton);
    click(buttonByText(container, 'Удалить'));
    expect(container.querySelector('[data-testid="history-delete-confirm"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-delete-button"]')).not.toBeNull();
  });

  it('ошибка удаления показывается рядом с действием, а не в начале секции', async () => {
    apiDelete.mockRejectedValueOnce(new Error('Запрещённый Origin'));
    const container = render();
    await flush();
    openConfirm(container);
    click(confirmButton(container));
    await flush();

    const errorNode = container.querySelector('[data-testid="history-delete-error"]');
    expect(errorNode).not.toBeNull();
    expect(errorNode.textContent).toContain('Запрещённый Origin');
    // The error lives INSIDE the row (next to the action), not at the section top.
    expect(errorNode.closest('li.history__row')).not.toBeNull();
    const sectionTopErrors = Array.from(container.querySelectorAll('section.history > p.error-text'));
    expect(sectionTopErrors).toHaveLength(0);
    // The confirmation block does not stay stuck open after the failure.
    expect(container.querySelector('.history__confirm')).toBeNull();
  });

  it('двойной клик по подтверждению даёт ровно один DELETE', async () => {
    let resolveDelete;
    apiDelete.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDelete = resolve; }),
    );
    const container = render();
    await flush();
    openConfirm(container);
    const confirmBtn = confirmButton(container);
    click(confirmBtn);
    expect(confirmBtn.disabled).toBe(true);
    click(confirmBtn);
    await flush();
    expect(apiDelete).toHaveBeenCalledTimes(1);
    act(() => { resolveDelete(undefined); });
    await flush();
    expect(container.querySelectorAll('.history__row')).toHaveLength(0);
  });

  it('404 — нейтральное «Статья уже удалена», строка убрана, без красной ошибки', async () => {
    apiDelete.mockRejectedValueOnce(new ApiError('Article not found', undefined, null, 404));
    const container = render();
    await flush();
    openConfirm(container);
    click(confirmButton(container));
    await flush();

    expect(container.querySelectorAll('.history__row')).toHaveLength(0);
    expect(container.textContent).toContain('Статья уже удалена');
    expect(container.querySelector('[data-testid="history-delete-error"]')).toBeNull();
    expect(container.querySelectorAll('p.error-text')).toHaveLength(0);
  });
});