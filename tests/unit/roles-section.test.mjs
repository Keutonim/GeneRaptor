// @vitest-environment jsdom
/**
 * M6 — раздел «Роли» (docs/ui-design.md §8, PROBE-1).
 *
 * Контракт под тестом: сервер — источник правды; промпт сохраняется через
 * PUT /api/settings/agent-roles, сброс — через DELETE; при недоступном
 * сервере редактор показывает предупреждение и не даёт сохранить.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { RolesSection } from '../../src/features/settings/RolesSection';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPut, apiDelete } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROLES = [
  {
    id: 'research-analyst',
    nameRu: 'Исследователь',
    systemPrompt: 'Собирай и проверяй факты по теме статьи, опирайся на источники и не выдумывай данные.',
    source: 'override',
    updatedAt: '2026-11-13T10:00:00.000Z',
  },
  {
    id: 'humanizer',
    nameRu: 'Гуманизатор',
    systemPrompt: 'Сделай текст живым и естественным, убери канцелярит и повторы, сохрани смысл и факты.',
    source: 'catalog',
    updatedAt: null,
  },
];

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
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
        React.createElement(RolesSection, null),
      ),
    );
  });
  return container;
}

/** Данные приходят с сервера асинхронно — дожидаемся их появления в DOM. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ success: true, data: { roles: ROLES } });
  apiPut.mockResolvedValue(undefined);
  apiDelete.mockResolvedValue(undefined);
});

describe('RolesSection — роли', () => {
  it('печатает роли из сервера (сервер — источник правды)', async () => {
    const container = render();
    await flush();
    const body = container.textContent;
    expect(body).toContain('Исследователь');
    expect(body).toContain('Гуманизатор');
    expect(body).toContain('critical');
  });

  it('сохраняет изменённый промпт через PUT', async () => {
    const container = render();
    await flush();
    const edit = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Изменить промпт'),
    );
    act(() => {
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const textarea = container.querySelector('textarea');
    const value = `${textarea.value} Дополнение.`;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сохранить');
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(apiPut).toHaveBeenCalledWith('/api/settings/agent-roles', {
      roleId: 'research-analyst',
      systemPrompt: value,
    });
  });

  it('после сохранения редактор показывает сохранённый промпт и статус «Сохранено»', async () => {
    const container = render();
    await flush();
    const edit = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Изменить промпт'),
    );
    act(() => {
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const textarea = container.querySelector('textarea');
    const value = `${textarea.value} Дополнение.`;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сохранить');
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const body = container.textContent;
    expect(body).toContain('Дополнение.');
    expect(body).toContain('Сохранено');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('сбрасывает роль через DELETE', async () => {
    const container = render();
    await flush();
    const reset = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сбросить');
    act(() => {
      reset.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(apiDelete).toHaveBeenCalledWith('/api/settings/agent-roles/research-analyst');
  });

  it('при недоступном сервере показывает предупреждение и не даёт сохранить', async () => {
    apiGet.mockRejectedValueOnce(new Error('Сервер недоступен'));
    const container = render();
    await flush();
    expect(container.textContent).toContain('Сервер недоступен');
    const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Сохранить');
    expect(save.disabled).toBe(true);
  });
});
