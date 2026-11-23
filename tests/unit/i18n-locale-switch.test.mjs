// @vitest-environment jsdom
/**
 * M7 — переключение языка интерфейса (docs/ui-design.md §11; решение D6).
 *
 * Контракт под тестом:
 *   - RU⇄EN перерисовывает весь интерфейс: в EN не остаётся русских подписей;
 *   - язык интерфейса НЕ связан с «языком материала» (D6): материал стартует
 *     с языка материала по умолчанию, а не с языка интерфейса.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AppShell } from '../../src/app/AppShell';
import { Composer } from '../../src/features/generation/Composer';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(async () => ({ success: true, data: {} })),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

const CYRILLIC = /[\u0400-\u04FF]/;

function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function mountShell(locale) {
  return mount(
    React.createElement(
      I18nProvider,
      { initialLocale: locale },
      React.createElement(
        ThemeProvider,
        { initialMode: 'light' },
        React.createElement(AppShell, {
          activeTab: 'generation',
          onTabChange: vi.fn(),
          children: React.createElement('div', null, 'content'),
        }),
      ),
    ),
  );
}

function mountComposer(locale) {
  return mount(
    React.createElement(
      I18nProvider,
      { initialLocale: locale },
      React.createElement(
        ThemeProvider,
        { initialMode: 'light' },
        // S5 T5: the composer now owns the controlled notes field (required props).
        React.createElement(Composer, { onNext: vi.fn(), notes: '', onNotesChange: vi.fn() }),
      ),
    ),
  );
}

/**
 * Видимые подписи элемента: текст листовых узлов + доступные имена
 * (aria-label) + подсказки (placeholder).
 */
function visibleTexts(root) {
  const texts = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.children.length === 0) {
      const text = el.textContent.trim();
      if (text) texts.push(text);
    }
    const label = el.getAttribute('aria-label');
    if (label) texts.push(label);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) texts.push(placeholder);
  }
  return texts;
}

describe('M7 — переключатель языка интерфейса', () => {
  let harness = null;

  afterEach(() => {
    if (harness) harness.unmount();
    harness = null;
    window.localStorage.clear();
    document.documentElement.removeAttribute('lang');
  });

  it('RU⇄EN перерисовывает все видимые подписи верхней панели', () => {
    harness = mountShell('ru');
    const topbar = harness.container.querySelector('.app-topbar');
    const ruTexts = visibleTexts(topbar);
    expect(ruTexts.length).toBeGreaterThan(3);

    const [ruButton, enButton] = harness.container
      .querySelectorAll('[role="radiogroup"]')[0]
      .querySelectorAll('button');
    expect(ruButton.textContent.trim()).toBe('RU');
    expect(enButton.textContent.trim()).toBe('EN');

    act(() => {
      enButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const enTexts = visibleTexts(topbar);
    // Не переводятся: коды языков и имя продукта.
    const invariant = new Set(['RU', 'EN', 'GeneRaptor']);
    for (const text of ruTexts) {
      if (invariant.has(text)) continue;
      expect(enTexts, `«${text}» должно быть переведено`).not.toContain(text);
    }
    expect(enTexts.join(' ')).not.toMatch(CYRILLIC);
  });

  it('английская версия композера не содержит русских строк', () => {
    harness = mountComposer('en');
    expect(harness.container.textContent).not.toMatch(CYRILLIC);
    expect(harness.container.querySelector('.page-title').textContent).toBe('New article');
  });

  it('язык материала не следует за языком интерфейса (D6)', () => {
    harness = mountComposer('en');
    const group = harness.container.querySelector('[aria-labelledby="composer-language-label"]');
    const [ruOption, enOption] = group.querySelectorAll('[role="radio"]');
    // Интерфейс — английский, материал по умолчанию — русский.
    expect(ruOption.getAttribute('aria-checked')).toBe('true');
    expect(enOption.getAttribute('aria-checked')).toBe('false');
  });
});
