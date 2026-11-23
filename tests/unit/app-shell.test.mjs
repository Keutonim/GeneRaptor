// @vitest-environment jsdom
/**
 * M6 — оболочка приложения (docs/ui-design.md §4).
 *
 * Контракт под тестом: ровно три вкладки (Генерация / История / Настройки),
 * переключатель языка интерфейса и переключатель темы — в верхней панели.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AppShell } from '../../src/app/AppShell';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onTabChange = vi.fn();
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(
          ThemeProvider,
          { initialMode: 'light' },
          React.createElement(
            AppShell,
            { activeTab: 'generation', onTabChange, children: React.createElement('div', null, 'content') },
          ),
        ),
      ),
    );
  });
  return {
    container,
    onTabChange,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const labels = (container) =>
  Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent.trim());

describe('AppShell — верхняя панель', () => {
  let harness;

  beforeEach(() => {
    harness = mount();
  });

  afterEach(() => {
    harness.unmount();
    document.documentElement.removeAttribute('data-theme');
  });

  it('показывает ровно три вкладки', () => {
    expect(labels(harness.container)).toEqual(['Генерация', 'История', 'Настройки']);
    expect(harness.container.querySelectorAll('[role="tab"]')).toHaveLength(3);
  });

  it('вызывает onTabChange при клике по вкладке', () => {
    const history = harness.container.querySelectorAll('[role="tab"]')[1];
    act(() => {
      history.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(harness.onTabChange).toHaveBeenCalledWith('history');
  });

  it('переключатель языка меняет подписи вкладок', () => {
    const [ru, en] = harness.container.querySelectorAll('[role="radiogroup"]')[0].querySelectorAll('button');
    expect(ru.textContent.trim()).toBe('RU');
    expect(en.textContent.trim()).toBe('EN');
    act(() => {
      en.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(labels(harness.container)).toEqual(['Generation', 'History', 'Settings']);
  });

  it('переключатель темы ставит data-theme на <html>', () => {
    const themeGroup = harness.container.querySelectorAll('[role="radiogroup"]')[1];
    const dark = Array.from(themeGroup.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Тёмная тема');
    act(() => {
      dark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('показывает строку сервера моноширинно', () => {
    const server = harness.container.querySelector('.app-server-line');
    // FIX-02: адрес — реальный origin страницы (window.location.host), а не
    // зашитая константа 127.0.0.1:8787 (этот ассерт и кодировал дефект).
    expect(server.textContent).toContain(window.location.host);
    expect(server.textContent).not.toContain('127.0.0.1:8787');
  });
});
